import type { Ref, TextareaHTMLAttributes } from 'react';

/** Shared capture input for the workspace, quick capture and floating reader. */
export default function DumpBox({inputRef, ...props}: TextareaHTMLAttributes<HTMLTextAreaElement> & {inputRef?: Ref<HTMLTextAreaElement>}) {
  return <textarea {...props} ref={inputRef} />;
}
