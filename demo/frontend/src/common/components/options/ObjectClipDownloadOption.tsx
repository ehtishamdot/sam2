import OptionButton from './OptionButton';
import useVideo from '../video/editor/useVideo';
import {sessionAtom} from '@/demo/atoms';
import {Download} from '@carbon/icons-react';
import {useAtomValue} from 'jotai';
import {useEffect, useState} from 'react';
import {VIDEO_API_ENDPOINT} from '@/demo/DemoConfig';

export default function ObjectClipDownloadOption() {
  const video = useVideo();
  const session = useAtomValue(sessionAtom);
  const [urls, setUrls] = useState<string[] | null>(null);

  useEffect(() => {
    function onCompleted() {
      if (session == null) {
        return;
      }
      fetch(`${VIDEO_API_ENDPOINT}/graphql`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          query: `query ObjectClipUrls($sessionId: String!) { objectClipUrls(sessionId: $sessionId) { objectId url } }`,
          variables: {sessionId: session.id},
        }),
      })
        .then(r => r.json())
        .then(res => {
          if (res.data && res.data.objectClipUrls) {
            setUrls(res.data.objectClipUrls.map((o: any) => o.url));
          }
        })
        .catch(() => {});
    }

    video?.addEventListener('streamingCompleted', onCompleted);
    return () => {
      video?.removeEventListener('streamingCompleted', onCompleted);
    };
  }, [video, session]);

  function handleClick() {
    if (!urls) {
      return;
    }
    urls.forEach(url => {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.target = '_blank';
      a.click();
    });
  }

  if (!urls) {
    return null;
  }

  return <OptionButton title="Download Clips" Icon={Download} onClick={handleClick} />;
}
