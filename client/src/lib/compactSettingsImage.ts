// Company settings are sent as JSON through a proxy with a 1 MB request limit.
// Leave room for both images and the other company fields.
const MAX_IMAGE_LENGTH = 350_000;

export async function compactSettingsImage(value: string): Promise<string> {
  if (!value?.startsWith('data:image/') || value.length <= MAX_IMAGE_LENGTH) return value;

  const image = new Image();
  image.src = value;
  try {
    await image.decode();
  } catch {
    throw new Error('The selected image could not be read. Please choose another PNG or JPG.');
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not resize the image.');

  // Resize first. PNG retains sharp QR edges and transparent logos when it fits.
  for (const maxSide of [1000, 800, 600, 450, 320]) {
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const png = canvas.toDataURL('image/png');
    if (png.length <= MAX_IMAGE_LENGTH) return png;

    // Photographic uploads compress much better as JPEG. Use a white background
    // so transparent pixels do not turn black in invoice/PDF renderers.
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'source-over';
    for (const quality of [0.85, 0.7, 0.55]) {
      const jpeg = canvas.toDataURL('image/jpeg', quality);
      if (jpeg.length <= MAX_IMAGE_LENGTH) return jpeg;
    }
  }

  throw new Error('The image is too complex to save. Please choose a smaller PNG or JPG.');
}
