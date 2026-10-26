import { useLocalize } from '~/hooks';

export default function VectoreePreviewExpired() {
  const localize = useLocalize();

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-primary px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl text-text-primary">{localize('com_auth_vectoree_preview_expired')}</h1>
        <p className="mt-3 text-sm text-text-secondary">
          {localize('com_auth_vectoree_preview_expired_note')}
        </p>
      </div>
    </div>
  );
}
