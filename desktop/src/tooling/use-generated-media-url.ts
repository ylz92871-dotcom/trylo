import { useEffect, useState } from 'react'
import { readPreviewBinary } from '../host-adapter/preview/resources'
import { MAX_BINARY_BYTES, RENDERABLE_IMAGE_MIME, type BinaryRef } from './tool-result-content'
import { useBinaryRefObjectUrl, type BinaryRefObjectUrlState } from './tool-result-store'

/** The conversation supplies allowedRoot. A persisted path cannot select its
 * own filesystem scope; the native preview reader checks real containment. */
export function useGeneratedMediaUrl(reference: BinaryRef, allowedRoot: string | undefined): BinaryRefObjectUrlState {
  const cached = useBinaryRefObjectUrl(reference.storage === 'ephemeral-tool-cache' ? reference : undefined)
  const key = JSON.stringify([allowedRoot, reference.storage, reference.path, reference.sha256, reference.size, reference.mimeType])
  const [loaded, setLoaded] = useState<{ key: string; url: string | null; failed: boolean }>({ key: '', url: null, failed: false })
  useEffect(() => {
    if (reference.storage !== 'workspace-artifact') return
    let active = true, url: string | undefined
    if (!allowedRoot || reference.size > MAX_BINARY_BYTES || !(RENDERABLE_IMAGE_MIME as readonly string[]).includes(reference.mimeType)) {
      setLoaded({ key, url: null, failed: true })
      return
    }
    void readPreviewBinary(reference.path, allowedRoot).then(async bytes => {
      const buffer = new Uint8Array(bytes).buffer
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(value => value.toString(16).padStart(2, '0')).join('')
      if (bytes.length !== reference.size || digest !== reference.sha256) throw new Error('Generated artifact changed')
      if (!active) return
      url = URL.createObjectURL(new Blob([buffer], { type: reference.mimeType }))
      setLoaded({ key, url, failed: false })
    }).catch(() => { if (active) setLoaded({ key, url: null, failed: true }) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [key, allowedRoot, reference.path, reference.sha256, reference.mimeType, reference.size, reference.storage])
  return reference.storage === 'ephemeral-tool-cache' ? cached : loaded.key === key ? loaded : { url: null, failed: false }
}
