import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, SecretInput, Spinner, Input } from '@librechat/client';
import type { FormEvent } from 'react';
import type { VectoreeAppAuthResult } from '~/data-provider/Vectoree';
import { getPostLoginRedirect, persistRedirectToSession } from '~/utils';
import { submitVectoreeAppAuth } from '~/data-provider/Vectoree';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { useLocalize } from '~/hooks';

const authInputClassName =
  'webkit-dark-styles transition-color peer h-auto w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pb-2.5 pt-3 text-text-primary duration-200 hover:border-border-light focus:border-accent-primary focus:outline-none focus-visible:border-accent-primary';
const authSecretInputClassName = `${authInputClassName} pr-12`;
const authLabelClassName =
  'absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-surface-primary px-2 text-sm text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-accent-primary rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4';
const authSecretButtonClassName =
  'size-9 rounded-xl text-text-secondary-alt hover:bg-transparent hover:text-text-primary';

export default function VectoreeLogin() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const redirectTo = new URLSearchParams(window.location.search).get('redirect_to');
    if (redirectTo) persistRedirectToSession(redirectTo);
  }, []);

  function enterApp(result: VectoreeAppAuthResult) {
    if (result.twoFAPending && result.tempToken) {
      navigate(`/login/2fa?tempToken=${encodeURIComponent(result.tempToken)}`, { replace: true });
      return;
    }
    const redirect = getPostLoginRedirect(new URLSearchParams(window.location.search)) ?? '/c/new';
    const base = document.querySelector('base')?.getAttribute('href') || '/';
    const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
    window.location.assign(`${prefix}${redirect}`);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setMessage(localize('com_auth_email_required'));
      return;
    }
    if (!needsCode && password.length < 6) {
      setMessage(localize('com_auth_vectoree_password_min'));
      return;
    }
    if (needsCode && !/^\d{8}$/.test(code.trim())) {
      setMessage(localize('com_auth_vectoree_login_code_hint'));
      return;
    }

    setSubmitting(true);
    setMessage(null);
    setNotice(null);
    try {
      if (needsCode) {
        const verified = await submitVectoreeAppAuth({
          action: 'verify',
          email: trimmedEmail,
          otp: code.trim(),
        });
        if (!verified.token && !verified.twoFAPending) {
          throw new Error(verified.message || localize('com_auth_vectoree_login_failed'));
        }
        enterApp(verified);
        return;
      }

      const signedUp = await submitVectoreeAppAuth({
        action: 'register',
        email: trimmedEmail,
        password,
      });
      if (signedUp.token || signedUp.twoFAPending) {
        enterApp(signedUp);
        return;
      }
      if (signedUp.requireEmailVerification) {
        setNeedsCode(true);
        setNotice(localize('com_auth_vectoree_login_code_hint'));
        return;
      }
      if (signedUp.status !== 409) {
        throw new Error(signedUp.message || localize('com_auth_vectoree_login_failed'));
      }

      const session = await submitVectoreeAppAuth({
        action: 'login',
        email: trimmedEmail,
        password,
      });
      if (session.token || session.twoFAPending) {
        enterApp(session);
        return;
      }
      if (session.requireEmailVerification) {
        setNeedsCode(true);
        setNotice(localize('com_auth_vectoree_login_code_hint'));
        return;
      }
      throw new Error(session.message || localize('com_auth_vectoree_login_failed'));
    } catch (error) {
      const fallback = localize('com_auth_vectoree_login_failed');
      setMessage(error instanceof Error ? error.message : fallback);
    } finally {
      setSubmitting(false);
    }
  }

  async function resendCode() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || submitting) return;
    setSubmitting(true);
    setMessage(null);
    setNotice(null);
    try {
      const resent = await submitVectoreeAppAuth({
        action: 'send-verification',
        email: trimmedEmail,
      });
      if (!resent.ok) {
        throw new Error(resent.message || localize('com_auth_email_resent_failed'));
      }
      setNotice(localize('com_auth_vectoree_login_resent'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : localize('com_auth_email_resent_failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <p className="mb-4 text-center text-sm text-text-secondary">
        {localize('com_auth_vectoree_login_description')}
      </p>
      {message ? <ErrorMessage>{message}</ErrorMessage> : null}
      {notice ? (
        <p className="mb-4 text-center text-sm text-text-primary" role="status">
          {notice}
        </p>
      ) : null}
      <form
        className="mt-6"
        aria-label={localize('com_auth_vectoree_login_title')}
        method="POST"
        onSubmit={onSubmit}
      >
        <div className="mb-4">
          <div className="relative">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-label={localize('com_auth_email')}
              className={authInputClassName}
              placeholder=" "
              required
              readOnly={needsCode}
            />
            <label htmlFor="email" className={authLabelClassName}>
              {localize('com_auth_email_address')}
            </label>
          </div>
        </div>
        {needsCode ? null : (
          <div className="mb-4">
            <div className="relative">
              <SecretInput
                id="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-label={localize('com_auth_password')}
                className={authSecretInputClassName}
                placeholder=" "
                label={localize('com_auth_password')}
                labelClassName={authLabelClassName}
                controlsClassName="right-2"
                buttonClassName={authSecretButtonClassName}
                required
                minLength={6}
              />
            </div>
          </div>
        )}
        {needsCode ? (
          <div className="mb-4">
            <div className="relative">
              <Input
                id="vectoree-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-label={localize('com_auth_vectoree_login_code')}
                className={authInputClassName}
                placeholder=" "
                required
                minLength={8}
                maxLength={8}
                pattern="[0-9]{8}"
              />
              <label htmlFor="vectoree-code" className={authLabelClassName}>
                {localize('com_auth_vectoree_login_code')}
              </label>
            </div>
            <button
              type="button"
              className="mt-2 text-sm text-accent-primary underline"
              onClick={resendCode}
              disabled={submitting}
            >
              {localize('com_auth_vectoree_login_resend')}
            </button>
          </div>
        ) : null}
        <Button
          type="submit"
          variant="submit"
          className="h-12 w-full rounded-2xl"
          disabled={submitting}
          aria-label={localize('com_auth_continue')}
        >
          {submitting ? <Spinner /> : localize('com_auth_continue')}
        </Button>
      </form>
    </>
  );
}
