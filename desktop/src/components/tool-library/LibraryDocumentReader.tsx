import { LearningDocumentReader } from '../user-learning/LearningDocumentReader'
import type { LearningDocument } from '../user-learning/learning-document'
import './library-reader.css'

/** The existing Markdown reader, contained to a library rather than a second viewer. */
export function LibraryDocumentReader({
  title,
  document,
  onClose,
  backLabel = '返回能力库',
}: {
  readonly title: string
  readonly document: LearningDocument
  readonly onClose: () => void
  readonly backLabel?: string
}) {
  return (
    <div className="library-document-reader">
      <LearningDocumentReader
        title={title}
        backLabel={backLabel}
        document={document}
        status="完整内容 · 只读"
        onClose={onClose}
      />
    </div>
  )
}
