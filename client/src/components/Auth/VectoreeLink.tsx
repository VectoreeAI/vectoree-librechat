import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Input, Spinner } from '@librechat/client';
import type { ChangeEvent, FormEvent } from 'react';
import type { VectoreeConnectSnapshot, VectoreeLinkStatus } from '~/data-provider/Vectoree';
import {
  startVectoreeLink,
  useVectoreeLinkPoll,
  useVectoreeLinkStatus,
  vectoreeLinkStatusKey,
} from '~/data-provider/Vectoree';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { extractProjectId } from '~/utils/vectoreeProject';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import AuthLayout from './AuthLayout';

const DEFAULT_API_URL = 'https://vectoree.ai';

const authInputClassName =
  'webkit-dark-styles transition-color peer h-auto w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pb-2.5 pt-3 text-text-primary duration-200 hover:border-border-light focus:border-accent-primary focus:outline-none focus-visible:border-accent-primary';
const authLabelClassName =
  'absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-surface-primary px-2 text-sm text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-accent-primary rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4';

type Phase = 'checking' | 'form' | 'pending' | 'linked' | 'error';

export default function VectoreeLink() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    data: startupConfig,
    isFetching,
    error: startupConfigError,
  } = useGetStartupConfig();
  const linkStatus = useVectoreeLinkStatus();
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [projectPaste, setProjectPaste] = useState('');
  const [phase, setPhase] = useState<Phase>('checking');
  const [message, setMessage] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const poll = useVectoreeLinkPoll(phase === 'pending');

  useEffect(() => {
    if (linkStatus.isLoading) return;
    if (linkStatus.data?.linked) {
      setPhase('linked');
      setProjectName(linkStatus.data.projectName);
      return;
    }
    setPhase((current) => (current === 'checking' ? 'form' : current));
  }, [linkStatus.data, linkStatus.isLoading]);

  useEffect(() => {
    if (phase !== 'linked') return;
    navigate('/login', { replace: true });
  }, [phase, navigate]);

  useEffect(() => {
    if (phase !== 'pending' || !poll.data) return;
    const snapshot = poll.data;
    if (snapshot.authorizeUrl) setAuthorizeUrl(snapshot.authorizeUrl);
    if (snapshot.projectName) setProjectName(snapshot.projectName);
    if (snapshot.status === 'linked') {
      setPhase('linked');
      queryClient.setQueryData<VectoreeLinkStatus>(vectoreeLinkStatusKey, {
        linked: true,
        projectName: snapshot.projectName,
        apiUrl: snapshot.apiUrl,
      });
      return;
    }
    if (snapshot.status === 'error') {
      setPhase('error');
      setMessage(snapshot.message ?? null);
    }
  }, [phase, poll.data, queryClient]);

  async function onConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectId = extractProjectId(projectPaste);
    if (!projectId) {
      setPhase('error');
      setMessage(localize('com_auth_vectoree_project_invalid'));
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const snapshot = await startVectoreeLink({ apiUrl: apiUrl.trim(), projectId });
      rememberSnapshot(snapshot);
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : localize('com_auth_vectoree_connect_failed'));
    } finally {
      setSubmitting(false);
    }
  }

  function rememberSnapshot(snapshot: VectoreeConnectSnapshot) {
    if (snapshot.authorizeUrl) setAuthorizeUrl(snapshot.authorizeUrl);
    if (snapshot.projectName) setProjectName(snapshot.projectName);
    if (snapshot.status === 'linked') {
      setPhase('linked');
      queryClient.setQueryData<VectoreeLinkStatus>(vectoreeLinkStatusKey, {
        linked: true,
        projectName: snapshot.projectName,
        apiUrl: snapshot.apiUrl,
      });
      return;
    }
    if (snapshot.status === 'error') {
      setPhase('error');
      setMessage(snapshot.message ?? localize('com_auth_vectoree_connect_failed'));
      return;
    }
    setPhase('pending');
  }

  if (!linkStatus.isLoading && linkStatus.data?.deployMode === 'cloud') {
    return <Navigate to={linkStatus.data.previewed ? '/login' : '/preview-expired'} replace />;
  }

  const showForm = phase === 'form' || phase === 'error';
  const statusNote =
    linkStatus.isError && showForm ? localize('com_auth_vectoree_status_unavailable') : null;

  return (
    <AuthLayout
      header={localize('com_auth_vectoree_title')}
      isFetching={isFetching && phase === 'checking'}
      startupConfig={startupConfig}
      startupConfigError={startupConfigError}
      pathname="/link"
      error={null}
    >
      <p className="mb-4 text-center text-sm text-text-secondary">
        {localize('com_auth_vectoree_description')}
      </p>
      {statusNote ? <ErrorMessage>{statusNote}</ErrorMessage> : null}
      {message ? <ErrorMessage>{message}</ErrorMessage> : null}
      {phase === 'checking' ? (
        <div className="mt-6 flex justify-center" role="status" aria-live="polite">
          <span className="sr-only">{localize('com_auth_vectoree_checking')}</span>
          <Spinner />
        </div>
      ) : null}
      {phase === 'linked' ? (
        <div className="mt-6" role="status" aria-live="polite">
          <p className="mb-4 text-center text-sm text-text-primary">
            {projectName
              ? localize('com_auth_vectoree_success_project', { 0: projectName })
              : localize('com_auth_vectoree_success')}
          </p>
          <p className="mb-4 text-center text-sm text-text-secondary">
            {localize('com_auth_vectoree_redirecting')}
          </p>
          <div className="flex justify-center">
            <Spinner />
          </div>
        </div>
      ) : null}
      {phase === 'pending' ? (
        <div className="mt-6" role="status" aria-live="polite">
          <p className="mb-4 text-center text-sm text-text-primary">
            {localize('com_auth_vectoree_pending')}
          </p>
          {authorizeUrl ? (
            <a
              className="mb-4 block break-all text-center text-sm text-accent-primary underline"
              href={authorizeUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {localize('com_auth_vectoree_open_login')}
            </a>
          ) : null}
          <div className="flex justify-center">
            <Spinner />
          </div>
        </div>
      ) : null}
      {showForm ? (
        <form className="mt-6" aria-label={localize('com_auth_vectoree_title')} onSubmit={onConnect}>
          <div className="mb-4">
            <div className="relative">
              <Input
                id="vectoree-api-url"
                type="url"
                value={apiUrl}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setApiUrl(event.target.value)}
                aria-label={localize('com_auth_vectoree_api_origin')}
                className={authInputClassName}
                placeholder=" "
                required
              />
              <label htmlFor="vectoree-api-url" className={authLabelClassName}>
                {localize('com_auth_vectoree_api_origin')}
              </label>
            </div>
          </div>
          <div className="mb-4">
            <div className="relative">
              <textarea
                id="vectoree-project"
                value={projectPaste}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setProjectPaste(event.target.value)}
                aria-label={localize('com_auth_vectoree_project')}
                className={`${authInputClassName} min-h-[6rem]`}
                placeholder=" "
                required
              />
              <label htmlFor="vectoree-project" className={authLabelClassName}>
                {localize('com_auth_vectoree_project')}
              </label>
            </div>
          </div>
          <Button
            type="submit"
            variant="submit"
            className="h-12 w-full rounded-2xl"
            disabled={submitting}
            aria-label={localize('com_auth_vectoree_connect')}
          >
            {submitting ? <Spinner /> : localize('com_auth_vectoree_connect')}
          </Button>
        </form>
      ) : null}
    </AuthLayout>
  );
}
