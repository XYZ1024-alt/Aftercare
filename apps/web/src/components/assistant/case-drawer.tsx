'use client';

import { useAssistant } from '../../lib/assistant.tsx';
import { Drawer } from '../overlay.tsx';
import { CaseWorkbench } from './case-workbench.tsx';

// The case panel of the conversation, opened on demand and closed again: it
// never takes a column of the page, and nothing of it is mounted before the
// first case is opened.

export function CaseDrawer() {
  const { drawer, closeDrawer } = useAssistant();
  return (
    <Drawer open={drawer !== null} onClose={closeDrawer} title="案例" size="lg">
      <div data-testid="case-drawer">
        {drawer !== null && (
          <CaseWorkbench
            key={`${drawer.caseId}:${drawer.tab ?? ''}`}
            caseId={drawer.caseId}
            initialTab={drawer.tab}
          />
        )}
      </div>
    </Drawer>
  );
}
