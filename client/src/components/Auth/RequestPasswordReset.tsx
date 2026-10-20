import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { loginPage } from 'librechat-data-provider';
import { Spinner, Button, SecretInput, Alert } from '@librechat/client';
import type { FormEvent, ReactNode } from 'react';
import type { TLoginLayoutContext } from '~/common';
import { submitVectoreeAppAuth } from '~/data-provider/Vectoree';
import { useLocalize } from '~/hooks';

function RequestPasswordReset() {
  const localize = useLocalize();
  const { setHeaderText } = useOutletContext<TLoginLayoutContext>();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function sendEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setMessage(localize('com_auth_email_required'));
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await submitVectoreeAppAuth({ action: 'send-reset', email: trimmed });
      if (!result.ok) {
        throw new Error(result.message || localize('com_auth_vectoree_reset_failed'));
      }
      setHeaderText('com_auth_reset_password_link_sent');
      setSent(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : localize('com_auth_vectoree_reset_failed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setMessage(localize('com_auth_vectoree_reset_code_hint'));
      return;
    }
    if (password.length < 6) {
      setMessage(localize('com_auth_vectoree_password_min'));
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const exchanged = await submitVectoreeAppAuth({
        action: 'exchange-reset',
        email: email.trim(),
        code: code.trim(),
      });
      if (!exchanged.ok || !exchanged.resetToken) {
        throw new Error(exchanged.message || localize('com_auth_vectoree_reset_failed'));
      }
      const reset = await submitVectoreeAppAuth({
        action: 'reset-password',
        password,
        otp: exchanged.resetToken,
      });
      if (!reset.ok) {
        throw new Error(reset.message || localize('com_auth_vectoree_reset_failed'));
      }
      setHeaderText('com_auth_reset_password_success');
      setDone(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : localize('com_auth_vectoree_reset_failed'));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Alert variant="success" icon={false} className="mt-6 px-6 py-4 shadow-sm transition-all">
        <Done />
      </Alert>
    );
  }

  if (!sent) {
    return (
      <form className="mt-8 space-y-6" aria-label="Password reset form" method="POST" onSubmit={sendEmail}>
        {message ? <AlertMessage>{message}</AlertMessage> : null}
        <EmailField email={email} setEmail={setEmail} />
        <div className="space-y-4">
          <Button
            aria-label="Continue with password reset"
            type="submit"
            disabled={submitting}
            variant="submit"
            className="h-12 w-full rounded-2xl"
          >
            {submitting ? <Spinner /> : localize('com_auth_continue')}
          </Button>
          <BackToLogin />
        </div>
      </form>
    );
  }

  return (
    <form className="mt-8 space-y-6" aria-label="Password reset code form" method="POST" onSubmit={submitCode}>
      <Alert variant="success" icon={false} className="px-6 py-4 shadow-sm transition-all">
        <p>{localize('com_auth_reset_password_if_email_exists')}</p>
        <p className="mt-3">{localize('com_auth_vectoree_reset_code_hint')}</p>
      </Alert>
      {message ? <AlertMessage>{message}</AlertMessage> : null}
      <label className="block text-sm text-text-secondary" htmlFor="reset-code">
        {localize('com_auth_vectoree_reset_code')}
        <input
          id="reset-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="webkit-dark-styles mt-2 h-12 w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 text-text-primary focus:border-accent-primary focus:outline-none"
        />
      </label>
      <SecretInput
        id="password"
        autoComplete="new-password"
        aria-label={localize('com_auth_password')}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="webkit-dark-styles h-12 w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pr-12 text-text-primary focus:border-accent-primary focus:outline-none"
        placeholder=" "
        label={localize('com_auth_password')}
        labelClassName="absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-surface-primary px-2 text-sm text-text-secondary-alt"
        controlsClassName="right-2"
        buttonClassName="size-9 rounded-xl text-text-secondary-alt hover:bg-transparent hover:text-text-primary"
      />
      <Button type="submit" disabled={submitting} variant="submit" className="h-12 w-full rounded-2xl">
        {submitting ? <Spinner /> : localize('com_auth_continue')}
      </Button>
      <BackToLogin />
    </form>
  );
}

function Done() {
  const localize = useLocalize();
  return (
    <div className="flex flex-col space-y-4">
      <p>{localize('com_auth_login_with_new_password')}</p>
      <a
        className="inline-flex text-sm font-medium text-accent-primary transition-colors hover:text-accent-primary-hover"
        href={loginPage()}
      >
        {localize('com_auth_back_to_login')}
      </a>
    </div>
  );
}

function BackToLogin() {
  const localize = useLocalize();
  return (
    <a
      href={loginPage()}
      className="block text-center text-sm font-medium text-accent-primary transition-colors hover:text-accent-primary-hover"
    >
      {localize('com_auth_back_to_login')}
    </a>
  );
}

function EmailField({ email, setEmail }: { email: string; setEmail: (value: string) => void }) {
  const localize = useLocalize();
  return (
    <div className="relative">
      <input
        type="email"
        id="email"
        autoComplete="email"
        aria-label={localize('com_auth_email')}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="webkit-dark-styles peer h-auto w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pb-2.5 pt-3 text-text-primary focus:border-accent-primary focus:outline-none"
        placeholder=" "
      />
      <label
        htmlFor="email"
        className="absolute -top-2 left-2 z-10 bg-surface-primary px-2 text-sm text-text-secondary"
      >
        {localize('com_auth_email_address')}
      </label>
    </div>
  );
}

function AlertMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm font-medium text-text-destructive">
      {children}
    </p>
  );
}

export default RequestPasswordReset;
