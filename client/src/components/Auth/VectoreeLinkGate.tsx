import { useEffect, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { Navigate, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  confirmPreviewSwitch,
  declinePreviewSwitch,
  nextVectoreeGate,
  redeemPreviewTicketOnce,
  takePreviewTicketFromLocation,
  useVectoreeLinkStatus,
  vectoreeLinkStatusKey,
} from '~/data-provider';
import { useLocalize } from '~/hooks';

type SwitchAsk = {
  projectName: string;
};

export default function VectoreeLinkGate() {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const status = useVectoreeLinkStatus();
  const [ticket] = useState(() => takePreviewTicketFromLocation());
  const [pendingTicket, setPendingTicket] = useState(() => Boolean(ticket));
  const [switchAsk, setSwitchAsk] = useState<SwitchAsk | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status.isLoading) return;
    if (status.data?.deployMode !== 'cloud') {
      setPendingTicket(false);
      return;
    }
    if (!ticket) {
      setPendingTicket(false);
      return;
    }
    let cancelled = false;
    redeemPreviewTicketOnce(ticket).then(async (body) => {
      if (cancelled) return;
      if (body?.confirm) {
        setSwitchAsk({
          projectName: body.projectName || body.projectId || '',
        });
        return;
      }
      await queryClient.invalidateQueries(vectoreeLinkStatusKey);
      setPendingTicket(false);
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient, status.data?.deployMode, status.isLoading, ticket]);

  async function stayOnCurrentProject(): Promise<void> {
    if (!switchAsk || busy) return;
    setBusy(true);
    try {
      await declinePreviewSwitch();
    } catch {
      // The pending switch expired or the preview session is gone; the status query below decides where to go.
    } finally {
      // A failed decline still must not trap the visitor on the prompt.
      setSwitchAsk(null);
      setPendingTicket(false);
      setBusy(false);
      await queryClient.invalidateQueries(vectoreeLinkStatusKey);
    }
  }

  async function switchProject(): Promise<void> {
    if (!switchAsk || busy) return;
    setBusy(true);
    try {
      await confirmPreviewSwitch();
      await queryClient.invalidateQueries(vectoreeLinkStatusKey);
      setSwitchAsk(null);
      setPendingTicket(false);
    } finally {
      setBusy(false);
    }
  }

  if (switchAsk) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-primary px-6">
        <div className="w-full max-w-md text-center">
          <h1 className="text-xl text-text-primary">
            {localize('com_auth_vectoree_preview_switch')}
          </h1>
          <p className="mt-3 text-sm text-text-secondary">
            {localize('com_auth_vectoree_preview_switch_note', {
              0: switchAsk.projectName,
            })}
          </p>
          <div className="mt-6 flex flex-col gap-3">
            <Button
              type="button"
              variant="submit"
              disabled={busy}
              onClick={() => void switchProject()}
            >
              {localize('com_auth_vectoree_preview_switch_confirm')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void stayOnCurrentProject()}
            >
              {localize('com_auth_vectoree_preview_switch_stay')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const gate = nextVectoreeGate(status.data, pendingTicket, status.isError);

  if (gate === 'loading') {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-surface-primary"
        role="status"
        aria-live="polite"
      >
        <span className="sr-only">{localize('com_auth_vectoree_checking')}</span>
        <Spinner />
      </div>
    );
  }

  if (gate === 'expired') {
    return <Navigate to="/preview-expired" replace />;
  }

  if (gate === 'link') {
    return <Navigate to="/link" replace />;
  }

  return <Outlet />;
}
