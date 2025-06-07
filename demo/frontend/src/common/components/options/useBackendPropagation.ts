import {getFileName} from './ShareUtils';
import {useAtomValue} from 'jotai';
import {sessionAtom} from '@/demo/atoms';
import useSettingsContext from '@/settings/useSettingsContext';
import {useState} from 'react';

export default function useBackendPropagation() {
  const {settings} = useSettingsContext();
  const session = useAtomValue(sessionAtom);
  const [progress, setProgress] = useState(0);
  const [state, setState] = useState<'default' | 'running' | 'completed'>('default');

  async function download() {
    if (!session) {
      return;
    }
    setState('running');
    await fetch(`${settings.inferenceAPIEndpoint}/background_propagate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: session.id, start_frame_index: 0}),
    });

    const interval = window.setInterval(async () => {
      const res = await fetch(
        `${settings.inferenceAPIEndpoint}/propagate_status/${session.id}`,
      );
      const data = await res.json();
      setProgress(data.progress);
      if (data.status === 'completed') {
        window.clearInterval(interval);
        const fileRes = await fetch(
          `${settings.inferenceAPIEndpoint}/download_segments/${session.id}`,
        );
        const blob = await fileRes.blob();
        saveVideo(blob, getFileName());
        setState('completed');
      }
    }, 1000);
  }

  function saveVideo(blob: Blob, fileName: string) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.setAttribute('href', url);
    a.setAttribute('download', fileName);
    a.setAttribute('target', '_self');
    a.click();
    window.URL.revokeObjectURL(url);
  }

  return {download, progress, state};
}
