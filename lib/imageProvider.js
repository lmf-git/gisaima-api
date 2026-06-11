// Thin wrapper over Cloudinary. We deliberately accept images as base64
// data-URIs in the (already-parsed) JSON request body, so no multipart-parsing
// dependency is needed — the data-URI string is handed straight to Cloudinary.
//
// The `cloudinary` package is imported lazily so the API still boots if it
// hasn't been installed yet; image features simply report as disabled.
//
// Requires env: CLOUDINARY_NAME, CLOUDINARY_CLIENT (api key), CLOUDINARY_SECRET.
let _cloudinary = null;

async function getCloudinary() {
  if (_cloudinary) return _cloudinary;
  const mod = await import('cloudinary');
  const cloudinary = mod.v2 || mod.default?.v2 || mod.default;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key:    process.env.CLOUDINARY_CLIENT,
    api_secret: process.env.CLOUDINARY_SECRET,
  });
  _cloudinary = cloudinary;
  return cloudinary;
}

export default class ImageProvider {
  static get enabled() {
    return !!(process.env.CLOUDINARY_NAME && process.env.CLOUDINARY_CLIENT && process.env.CLOUDINARY_SECRET);
  }

  // Upload a base64 data-URI (e.g. "data:image/png;base64,...") or a raw URL.
  // Returns the secure_url, or throws on failure.
  static async upload(dataUriOrUrl, { folder = 'gisaima', transformation } = {}) {
    const cloudinary = await getCloudinary();
    const result = await cloudinary.uploader.upload(dataUriOrUrl, {
      folder,
      resource_type: 'image',
      overwrite: true,
      ...(transformation ? { transformation } : {}),
    });
    return result.secure_url;
  }

  // Delete a Cloudinary asset by its URL. Best-effort; never throws.
  static async delete(url) {
    try {
      const cloudinary = await getCloudinary();
      const CLOUDINARY_REGEX = /^.+\.cloudinary\.com\/(?:[^/]+\/)(?:(image|video|raw)\/)?(?:(upload|fetch|private|authenticated|sprite|facebook|twitter|youtube|vimeo)\/)?(?:(?:[^_/]+_[^,/]+,?)*\/)?(?:v(\d+|\w{1,2})\/)?([^.^\s]+)(?:\.(.+))?$/;
      const parts = CLOUDINARY_REGEX.exec(url);
      const id = parts && parts.length > 2 ? parts[parts.length - 2] : url;
      return await cloudinary.api.delete_resources([id]);
    } catch (e) {
      console.error('[image] delete failed', e?.message || e);
      return null;
    }
  }
}
