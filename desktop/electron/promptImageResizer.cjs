'use strict'

/**
 * Codex-aligned prompt image resize (high/auto):
 * longest edge ≤ 2048 and ceil(w/32)*ceil(h/32) ≤ 2500.
 */

const PATCH_SIZE = 32
const MAX_DIMENSION = 2048
const MAX_PATCHES = 2500
const JPEG_QUALITY = 85

function computeTargetSize(width, height) {
  if (width <= 0 || height <= 0) {
    return { width: Math.max(1, width), height: Math.max(1, height) }
  }

  let w = width
  let h = height

  const maxSide = Math.max(w, h)
  if (maxSide > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / maxSide
    w = Math.floor(w * scale)
    h = Math.floor(h * scale)
    w = Math.max(1, w)
    h = Math.max(1, h)
  }

  let patchW = Math.ceil(w / PATCH_SIZE)
  let patchH = Math.ceil(h / PATCH_SIZE)
  if (patchW * patchH > MAX_PATCHES) {
    const scale = Math.sqrt(MAX_PATCHES / (patchW * patchH))
    let newPatchW = Math.max(1, Math.floor(patchW * scale))
    let newPatchH = Math.max(1, Math.floor(patchH * scale))
    while (newPatchW * newPatchH > MAX_PATCHES) {
      if (newPatchW >= newPatchH && newPatchW > 1) newPatchW--
      else if (newPatchH > 1) newPatchH--
      else break
    }
    return { width: newPatchW * PATCH_SIZE, height: newPatchH * PATCH_SIZE }
  }

  return { width: Math.round(w), height: Math.round(h) }
}

function fitsPromptLimits(width, height) {
  if (width <= 0 || height <= 0) return false
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return false
  const patches = Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE)
  return patches <= MAX_PATCHES
}

/**
 * @param {Buffer} buffer
 * @param {string} mimeHint
 * @param {typeof import('electron').nativeImage} nativeImage
 * @returns {{ buffer: Buffer, mime: string, width: number, height: number, resized: boolean } | null}
 */
function resizeForPrompt(buffer, mimeHint, nativeImage) {
  if (!buffer || !buffer.length || !nativeImage) return null
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return null
    const { width: srcW, height: srcH } = image.getSize()
    if (!srcW || !srcH) return null

    const target = computeTargetSize(srcW, srcH)
    const needsResize = target.width !== srcW || target.height !== srcH
      || !fitsPromptLimits(srcW, srcH)

    let outImage = image
    if (needsResize) {
      outImage = image.resize({
        width: target.width,
        height: target.height,
        quality: 'better'
      })
    } else {
      return {
        buffer,
        mime: mimeHint || 'image/png',
        width: srcW,
        height: srcH,
        resized: false
      }
    }

    const outMime = encodeMimeFor(mimeHint)
    let outBuffer
    if (outMime === 'image/jpeg') {
      outBuffer = outImage.toJPEG(JPEG_QUALITY)
    } else {
      outBuffer = outImage.toPNG()
    }
    if (!outBuffer || !outBuffer.length) return null

    const size = outImage.getSize()
    return {
      buffer: outBuffer,
      mime: outMime === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      width: size.width || target.width,
      height: size.height || target.height,
      resized: true
    }
  } catch {
    return null
  }
}

function encodeMimeFor(mimeHint) {
  const m = (mimeHint || '').split(';')[0].trim().toLowerCase()
  if (m === 'image/jpeg' || m === 'image/jpg') return 'image/jpeg'
  // GIF/WebP/PNG → PNG after resize (Electron nativeImage)
  return 'image/png'
}

module.exports = {
  PATCH_SIZE,
  MAX_DIMENSION,
  MAX_PATCHES,
  JPEG_QUALITY,
  computeTargetSize,
  fitsPromptLimits,
  resizeForPrompt
}
