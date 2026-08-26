import { Media } from './dto/media';

export interface UploadOptions {
  file: File;
  url: string;
  date: string;
  onProgress: (percent: number) => void;
  timeoutMs: number;
}

/**
 * Uploads a file using XMLHttpRequest, providing progress tracking.
 * Uses XHR instead of fetch() because the Fetch API does not expose upload progress events.
 */
export function uploadFile(options: UploadOptions): Promise<Media> {
  const { file, url, date, onProgress, timeoutMs } = options;

  return new Promise<Media>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable) {
        const percent = Math.floor((event.loaded / event.total) * 100);
        onProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const media: Media = JSON.parse(xhr.responseText);
          resolve(media);
        } catch {
          reject(new Error('Failed to parse response JSON'));
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
      }
    };

    xhr.ontimeout = () => {
      reject(new Error('Upload timed out'));
    };

    xhr.onerror = () => {
      reject(new Error('Network error during upload'));
    };

    xhr.open('POST', url);
    xhr.timeout = timeoutMs;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('date', date);

    xhr.send(formData);
  });
}
