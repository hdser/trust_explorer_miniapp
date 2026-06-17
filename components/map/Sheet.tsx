'use client';

import type { ReactNode } from 'react';

/**
 * A bottom-sheet overlay that sits inside the map container (normal flow, not
 * `position: fixed`) so it composes cleanly inside the wallet iframe.
 */
export function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border bg-card text-card-foreground shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="max-h-[60vh] overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
