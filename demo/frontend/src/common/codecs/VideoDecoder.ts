/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {cloneFrame} from '@/common/codecs/WebCodecUtils';
import {FileStream} from '@/common/utils/FileUtils';
import {
  createFile,
  DataStream,
  MP4ArrayBuffer,
  MP4File,
  MP4Sample,
  MP4VideoTrack,
} from 'mp4box';
import {isAndroid, isChrome, isEdge, isWindows} from 'react-device-detect';

export type ImageFrame = {
  bitmap: VideoFrame;
  timestamp: number;
  duration: number;
};

export type DecodedVideo = {
  width: number;
  height: number;
  numFrames: number;
  fps: number;
  frames: AsyncGenerator<ImageFrame, void>;
};

type DecodedMetadata = Omit<DecodedVideo, 'frames'>;

function decodeInternal(
  identifier: string,
  onReady: (mp4File: MP4File) => Promise<void>,
  onFrame: (frame: ImageFrame) => void,
  onMetadata: (meta: DecodedMetadata) => void,
  onDone: () => void,
): void {
  const globalSamples: MP4Sample[] = [];

  let decoder: VideoDecoder;

  let track: MP4VideoTrack | null = null;
  const mp4File = createFile();

  mp4File.onError = error => {
    onDone();
    throw error;
  };
  mp4File.onReady = async info => {
      if (info.videoTracks.length > 0) {
        track = info.videoTracks[0];
      } else {
        // The video does not have a video track, so looking if there is an
        // "otherTracks" available. Note, I couldn't find any documentation
        // about "otherTracks" in WebCodecs [1], but it was available in the
        // info for MP4V-ES, which isn't supported by Chrome [2].
        // However, we'll still try to get the track and then throw an error
        // further down in the VideoDecoder.isConfigSupported if the codec is
        // not supported by the browser.
        //
        // [1] https://www.w3.org/TR/webcodecs/
        // [2] https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Video_codecs#mp4v-es
        track = info.otherTracks[0];
      }


      if (track == null) {
        onDone();
        throw new Error(`${identifier} does not contain a video track`);
      }

      onMetadata({
        width: track.track_width,
        height: track.track_height,
        numFrames: track.nb_samples,
        fps: (track.nb_samples / track.duration) * track.timescale,
      });

      const timescale = track.timescale;
      const edits = track.edits;

      let frame_n = 0;
      decoder = new VideoDecoder({
        async output(inputFrame) {
          if (track == null) {
            onDone();
            throw new Error(`${identifier} does not contain a video track`);
          }

          const saveTrack = track;

          if (edits != null && edits.length > 0) {
            const cts = Math.round(
              (inputFrame.timestamp * timescale) / 1_000_000,
            );
            if (cts < edits[0].media_time) {
              inputFrame.close();
              return;
            }
          }

          if (
            (isAndroid && isChrome) ||
            (isWindows && isChrome) ||
            (isWindows && isEdge)
          ) {
            const clonedFrame = await cloneFrame(inputFrame);
            inputFrame.close();
            inputFrame = clonedFrame;
          }

          const sample = globalSamples[frame_n];
          if (sample != null) {
            const duration = (sample.duration * 1_000_000) / sample.timescale;
            onFrame({
              bitmap: inputFrame,
              timestamp: inputFrame.timestamp,
              duration,
            });
          }
          frame_n++;

          if (saveTrack.nb_samples === frame_n) {
            onDone();
          }
        },
        error() {
          onDone();
        },
      });

      let description;
      const trak = mp4File.getTrackById(track.id);
      const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;
      if (entries == null) {
        return;
      }
      for (const entry of entries) {
        if (entry.avcC || entry.hvcC) {
          const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
          if (entry.avcC) {
            entry.avcC.write(stream);
          } else if (entry.hvcC) {
            entry.hvcC.write(stream);
          }
          description = new Uint8Array(stream.buffer, 8); // Remove the box header.
          break;
        }
      }

      const configuration: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.track_width,
        codedHeight: track.track_height,
        description,
      };
      const supportedConfig =
        await VideoDecoder.isConfigSupported(configuration);
      if (supportedConfig.supported == true) {
        decoder.configure(configuration);

        mp4File.setExtractionOptions(track.id, null, {
          nbSamples: Infinity,
        });
        mp4File.start();
      } else {
        onDone();
        throw new Error(
          `Decoder config faile: config ${JSON.stringify(
            supportedConfig.config,
          )} is not supported`,
        );
      }
    };

    mp4File.onSamples = async (
      _id: number,
      _user: unknown,
      samples: MP4Sample[],
    ) => {
      for (const sample of samples) {
        globalSamples.push(sample);
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: (sample.cts * 1_000_000) / sample.timescale,
            duration: (sample.duration * 1_000_000) / sample.timescale,
            data: sample.data,
          }),
        );
      }
      await decoder.flush();
      decoder.close();
    };

    onReady(mp4File);
  });
}

export async function decode(
  file: File,
  onProgress?: (meta: DecodedMetadata & {framesDecoded: number}) => void,
): Promise<DecodedVideo> {
  async function* fileStream(): FileStream {
    const buffer = new Uint8Array(await file.arrayBuffer());
    yield {data: buffer, range: {start: 0, end: buffer.length}, contentLength: buffer.length};
    return file;
  }
  return decodeStream(fileStream(), onProgress);
}

export async function decodeStream(
  fileStream: FileStream,
  onProgress?: (meta: DecodedMetadata & {framesDecoded: number}) => void,
): Promise<DecodedVideo> {
  let metadata: DecodedMetadata | null = null;
  let decoded = 0;
  let done = false;
  const queue: ImageFrame[] = [];
  let resolveNext: ((v: IteratorResult<ImageFrame>) => void) | null = null;

  const frames: AsyncGenerator<ImageFrame, void> = {
    async next() {
      if (queue.length) {
        return {value: queue.shift()!, done: false};
      }
      if (done) {
        return {value: undefined, done: true};
      }
      return new Promise<IteratorResult<ImageFrame>>(res => {
        resolveNext = res;
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  let resolveMeta: ((meta: DecodedVideo) => void) | null = null;
  const metaPromise = new Promise<DecodedVideo>(res => (resolveMeta = res));

  decodeInternal(
    'stream',
    async (mp4File: MP4File) => {
      let part = await fileStream.next();
      while (part.done === false) {
        const result = part.value.data.buffer as MP4ArrayBuffer;
        if (result != null) {
          result.fileStart = part.value.range.start;
          mp4File.appendBuffer(result);
        }
        mp4File.flush();
        part = await fileStream.next();
      }
    },
    frame => {
      decoded++;
      if (onProgress && metadata != null) {
        onProgress({...metadata, framesDecoded: decoded});
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({value: frame, done: false});
      } else {
        queue.push(frame);
      }
    },
    meta => {
      metadata = meta;
      if (resolveMeta) {
        resolveMeta({
          ...meta,
          frames,
        });
        resolveMeta = null;
      }
    },
    () => {
      done = true;
      if (resolveNext) {
        resolveNext({value: undefined, done: true});
      }
    },
  );

  return metaPromise;
}
