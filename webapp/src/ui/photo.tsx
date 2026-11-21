import { useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from './icons';
import { Spinner, cx } from './kit';
import { toast } from './toast';

/**
 * Shrinks a photo on the phone before upload: longest side ≤ 1600 px, JPEG ≈ 1 MB or less.
 * Netlify accepts at most ~6 MB per request, and 3G is slow.
 */
export async function compressImage(file: File, maxSide = 1600, maxBytes = 1_000_000): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    let quality = 0.82;
    let blob: Blob | null = null;
    for (let i = 0; i < 6; i++) {
      blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size <= maxBytes) break;
      quality -= 0.12;
    }
    if (!blob) throw new Error("Rasmni o'qib bo'lmadi");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadPhoto(file: File, kind: string): Promise<{ id: number; url: string }> {
  const blob = await compressImage(file);
  return api.upload(`/files?kind=${kind}&name=${encodeURIComponent(file.name || 'photo.jpg')}`, blob);
}

/** Photo picker: opens the camera/gallery, compresses and uploads. */
export function PhotoPicker({
  kind,
  url,
  onUploaded,
  label = 'Rasm',
  className,
}: {
  kind: string;
  url?: string | null;
  onUploaded: (f: { id: number; url: string }) => void;
  label?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? url;
  return (
    <button
      type="button"
      onClick={() => input.current?.click()}
      className={cx('relative flex h-28 w-28 items-center justify-center overflow-hidden rounded-[18px] border border-dashed border-line bg-card text-muted', className)}
    >
      {shown ? <img src={shown} alt="" className="h-full w-full object-cover" /> : (
        <div className="flex flex-col items-center gap-1 text-[13px]">
          <Icon name="camera" />
          {label}
        </div>
      )}
      {busy && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
          <Spinner />
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          try {
            setPreview(URL.createObjectURL(f));
            const up = await uploadPhoto(f, kind);
            onUploaded(up);
          } catch (err) {
            setPreview(null);
            toast.error(err);
          } finally {
            setBusy(false);
          }
        }}
      />
    </button>
  );
}
