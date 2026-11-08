import { memo, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AnswerLink } from './AnswerLink';
import { InlineFileReference } from './InlineFileReference';
import { referenceProperty, rehypeFileReferences } from './file-references';

const plugins = [rehypeFileReferences];
const gfmPlugins = [remarkGfm];

// Parsing stays behind the memo boundary while unrelated streaming rows update.
export const AssistantAnswer = memo(function AssistantAnswer(props: {
  readonly text: string;
  readonly gfm?: boolean;
  readonly onOpenArtifact?: (path: string) => void;
  readonly artifactHost?: import('../../host-adapter/artifact-actions').ArtifactHost;
}): ReactElement {
  return <div className="message__text message__text--markdown">
    <ReactMarkdown rehypePlugins={plugins} remarkPlugins={props.gfm ? gfmPlugins : undefined} components={{
      a: ({ href, children, node }) => <AnswerLink href={href} onOpenArtifact={props.onOpenArtifact}
        artifactHost={props.artifactHost} caption={referenceProperty(node, 'data-file-caption')}
        directory={referenceProperty(node, 'data-file-directory')}>{children}</AnswerLink>,
      code: ({ children, className, node }) => {
        const path = referenceProperty(node, 'data-file-reference');
        return path && props.onOpenArtifact ? <InlineFileReference path={path}
          directory={referenceProperty(node, 'data-file-directory')}
          onOpen={() => props.onOpenArtifact?.(path.replace(/\\/g, '/'))} />
          : <code className={className}>{children}</code>;
      },
    }}>{props.text}</ReactMarkdown>
  </div>;
});
