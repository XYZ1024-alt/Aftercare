'use client';

import { useEffect, useRef } from 'react';
import { useAssistant } from '../../lib/assistant.tsx';
import { Drawer } from '../overlay.tsx';
import { CaseWorkbench } from './case-workbench.tsx';

// The case panel of the conversation, opened on demand and closed again: it
// never takes a column of the page, and nothing of it is mounted before the
// first case is opened.

export function CaseDrawer() {
  const { drawer, closeDrawer } = useAssistant();
  // The panel stays on the last case it showed while it slides out, so its
  // content does not blank halfway through the close transition.
  const last = useRef(drawer);
  useEffect(() => {
    if (drawer !== null) last.current = drawer;
  }, [drawer]);
  const shown = drawer ?? last.current;
  return (
    <Drawer open={drawer !== null} onClose={closeDrawer} title="案例">
      <div data-testid="case-drawer">
        {shown !== null && (
          <CaseWorkbench
            key={`${shown.caseId}:${shown.tab ?? ''}`}
            caseId={shown.caseId}
            initialTab={shown.tab}
          />
        )}
      </div>
    </Drawer>
  );
}
