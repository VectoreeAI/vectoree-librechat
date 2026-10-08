import { Spinner } from '@librechat/client';
import { Navigate, Outlet } from 'react-router-dom';
import { useVectoreeLinkStatus } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function VectoreeLinkGate() {
  const localize = useLocalize();
  const status = useVectoreeLinkStatus();

  if (status.isLoading) {
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

  if (status.isError || status.data?.linked !== true) {
    return <Navigate to="/link" replace />;
  }

  return <Outlet />;
}
