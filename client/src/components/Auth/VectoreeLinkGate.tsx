import { useEffect, useState } from 'react';
import { Spinner } from '@librechat/client';
import { Navigate, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  forgetPreviewTicket,
  nextVectoreeGate,
  redeemPreviewTicketOnce,
  useVectoreeLinkStatus,
  vectoreeLinkStatusKey,
} from '~/data-provider';
import { useLocalize } from '~/hooks';

function ticketInLocation(): string | null {
  return new URLSearchParams(window.location.search).get('ticket');
}

export default function VectoreeLinkGate() {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const status = useVectoreeLinkStatus();
  const [pendingTicket, setPendingTicket] = useState(() => Boolean(ticketInLocation()));

  useEffect(() => {
    if (status.isLoading) return;
    if (status.data?.deployMode !== 'cloud') {
      setPendingTicket(false);
      return;
    }
    const ticket = ticketInLocation();
    if (!ticket) {
      setPendingTicket(false);
      return;
    }
    let cancelled = false;
    redeemPreviewTicketOnce(ticket).finally(async () => {
      await queryClient.invalidateQueries(vectoreeLinkStatusKey);
      forgetPreviewTicket();
      if (!cancelled) setPendingTicket(false);
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient, status.data?.deployMode, status.isLoading]);

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
