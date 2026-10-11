"use client";

import { useEffect, useRef } from "react";
import { deleteConfirmMessage } from "@/lib/photoSelection";

type Props = {
  filenames: string[];
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Cancel holds the initial focus so a stray Enter never deletes anything. */
export default function DeleteConfirmDialog({ filenames, busy, error, onConfirm, onCancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previouslyFocused?.focus(); };
  }, []);
  return (
    <dialog ref={dialog} className="confirm-dialog" aria-labelledby="delete-title" aria-describedby="delete-message"
      onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id="delete-title">Delete photos</h2>
      <p id="delete-message" className="confirm-dialog__message">{deleteConfirmMessage(filenames)}</p>
      {error && <p className="confirm-dialog__error" role="alert">{error}</p>}
      <div className="confirm-dialog__actions">
        <button className="button" onClick={onCancel} disabled={busy} autoFocus>Cancel</button>
        <button className="button button--danger" onClick={onConfirm} disabled={busy}>{busy ? "Deleting…" : "Delete"}</button>
      </div>
    </dialog>
  );
}
