import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";

export function YamlEditor({
  value,
  onChange,
  readOnly = false,
  className,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          yaml(),
          oneDark,
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { backgroundColor: "transparent" },
            ".cm-gutters": { backgroundColor: "#0b1117", borderRight: "1px solid #1d2b36" },
            ".cm-activeLine": { backgroundColor: "rgba(45,212,191,0.045)" },
            ".cm-activeLineGutter": { backgroundColor: "rgba(45,212,191,0.06)" },
            ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(45,212,191,0.18) !important" },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            lastValueRef.current = next;
            onChangeRef.current?.(next);
          }),
          EditorView.editable.of(!readOnly),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is owned by CodeMirror after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return <div ref={hostRef} className={className} />;
}
