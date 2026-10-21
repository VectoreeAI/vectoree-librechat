import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, SecretInput, Spinner, Input } from '@librechat/client';
import type { FormEvent } from 'react';
import type { VectoreeAppAuthResult } from '~/data-provider/Vectoree';
import { submitVectoreeAppAuth } from '~/data-provider/Vectoree';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { useAuthContext, useLocalize } from '~/hooks';
import { persistRedirectToSession } from '~/utils';

const authInputClassName =
  'webkit-dark-styles transition-color peer h-auto w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pb-2.5 pt-3 text-text-primary duration-200 hover:border-border-light focus:border-accent-primary focus:outline-none focus-visible:border-accent-primary';
const authSecretInputClassName = `${authInputClassName} pr-12`;
const authLabelClassName =
  'absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-surface-primary px-2 text-sm text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-accent-primary rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4';
const authSecretButtonClassName =
  'size-9 rounded-xl text-text-secondary-alt hover:bg-transparent hover:text-text-primary';

type LoginMethod = 'email' | 'password';

export default function VectoreeLogin() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { acceptSession } = useAuthContext();
  const [method, setMethod] = useState<LoginMethod>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
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
    if (!result.token) {
      throw new Error(result.message || localize('com_auth_vectoree_login_failed'));
    }
    acceptSession({ token: result.token, user: result.user });
  }

  function selectMethod(next: LoginMethod) {
    setMethod(next);
    setNeedsCode(false);
    setNeedsPassword(false);
    setConfirmPassword('');
    setCode('');
    setMessage(null);
    setNotice(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setMessage(localize('com_auth_email_required'));
      return;
    }
    if (needsCode && !/^\d{8}$/.test(code.trim())) {
      setMessage(localize('com_auth_vectoree_login_code_hint'));
      return;
    }
    if (!needsCode && (method === 'password' || needsPassword) && password.length < 8) {
      setMessage(localize('com_auth_vectoree_password_min'));
      return;
    }
    if (!needsCode && (method === 'password' || needsPassword) && password.length > 128) {
      setMessage(localize('com_auth_password_max_length'));
      return;
    }
    if (needsPassword && password !== confirmPassword) {
      setMessage(localize('com_auth_vectoree_password_mismatch'));
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

      const started =
        method === 'email'
          ? await submitVectoreeAppAuth({
              action: 'start',
              email: trimmedEmail,
              ...(needsPassword ? { password } : {}),
            })
          : await submitVectoreeAppAuth({ action: 'login', email: trimmedEmail, password });
      if (started.token || started.twoFAPending) {
        enterApp(started);
        return;
      }
      if (started.requirePassword) {
        setNeedsPassword(true);
        setNotice(localize('com_auth_vectoree_login_set_password'));
        return;
      }
      if (started.usePassword) {
        setNeedsPassword(false);
        setMethod('password');
        setMessage(localize('com_auth_vectoree_login_use_password'));
        return;
      }
      if (started.requireEmailVerification) {
        setNeedsCode(true);
        setNeedsPassword(false);
        setNotice(localize('com_auth_vectoree_login_code_hint'));
        return;
      }
      throw new Error(started.message || localize('com_auth_vectoree_login_failed'));
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

  const description = needsPassword
    ? localize('com_auth_vectoree_login_set_password')
    : method === 'password'
      ? localize('com_auth_vectoree_login_password_description')
      : localize('com_auth_vectoree_login_description');

  return (
    <>
      <div
        role="tablist"
        aria-label={localize('com_auth_vectoree_login_title')}
        className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-surface-secondary p-1"
      >
        <button
          type="button"
          role="tab"
          id="vectoree-login-email-tab"
          aria-selected={method === 'email'}
          aria-controls="vectoree-login-panel"
          className={`rounded-xl px-3 py-2 text-sm ${method === 'email' ? 'bg-surface-primary text-text-primary' : 'text-text-secondary'}`}
          onClick={() => selectMethod('email')}
        >
          {localize('com_auth_vectoree_login_email_tab')}
        </button>
        <button
          type="button"
          role="tab"
          id="vectoree-login-password-tab"
          aria-selected={method === 'password'}
          aria-controls="vectoree-login-panel"
          className={`rounded-xl px-3 py-2 text-sm ${method === 'password' ? 'bg-surface-primary text-text-primary' : 'text-text-secondary'}`}
          onClick={() => selectMethod('password')}
        >
          {localize('com_auth_vectoree_login_password_tab')}
        </button>
      </div>
      <p className="mb-4 text-center text-sm text-text-secondary">{description}</p>
      {message ? <ErrorMessage>{message}</ErrorMessage> : null}
      {notice ? (
        <p className="mb-4 text-center text-sm text-text-primary" role="status">
          {notice}
        </p>
      ) : null}
      <form
        id="vectoree-login-panel"
        role="tabpanel"
        aria-labelledby={method === 'email' ? 'vectoree-login-email-tab' : 'vectoree-login-password-tab'}
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
        {!needsCode && (method === 'password' || needsPassword) ? (
          <div className="mb-4">
            <div className="relative">
              <SecretInput
                id="password"
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
                minLength={8}
                maxLength={128}
                autoComplete={needsPassword ? 'new-password' : 'current-password'}
              />
            </div>
          </div>
        ) : null}
        {needsPassword ? (
          <div className="mb-4">
            <div className="relative">
              <SecretInput
                id="confirm-password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                aria-label={localize('com_auth_vectoree_password_confirm')}
                className={authSecretInputClassName}
                placeholder=" "
                label={localize('com_auth_vectoree_password_confirm')}
                labelClassName={authLabelClassName}
                controlsClassName="right-2"
                buttonClassName={authSecretButtonClassName}
                required
                minLength={8}
                maxLength={128}
              />
            </div>
          </div>
        ) : null}
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
