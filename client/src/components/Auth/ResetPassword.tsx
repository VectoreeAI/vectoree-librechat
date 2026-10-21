import { useState } from 'react';
import { Spinner, Button, SecretInput, Alert } from '@librechat/client';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import type { FormEvent } from 'react';
import type { TLoginLayoutContext } from '~/common';
import VectoreeWalletNotice from '~/components/Auth/VectoreeWalletNotice';
import { submitVectoreeAppAuth } from '~/data-provider/Vectoree';
import { useLocalize } from '~/hooks';

function ResetPassword() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { setHeaderText } = useOutletContext<TLoginLayoutContext>();
  const token = params.get('token') ?? '';
  const linkError = params.get('vectoree_status') === 'error' ? params.get('vectoree_error') : null;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<string | null>(linkError);
  const [walletBillingUrl, setWalletBillingUrl] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const authInputClassName =
    'webkit-dark-styles transition-color peer h-auto w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pb-2.5 pr-12 pt-3 text-text-primary duration-200 hover:border-border-light focus:border-accent-primary focus:outline-none focus-visible:border-accent-primary';
  const authLabelClassName =
    'absolute start-3 top-1.5 z-10 origin-[0] -translate-y-4 scale-75 transform bg-surface-primary px-2 text-sm text-text-secondary-alt duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-1.5 peer-focus:-translate-y-4 peer-focus:scale-75 peer-focus:px-2 peer-focus:text-accent-primary rtl:peer-focus:left-auto rtl:peer-focus:translate-x-1/4';
  const authSecretButtonClassName =
    'size-9 rounded-xl text-text-secondary-alt hover:bg-transparent hover:text-text-primary';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      setMessage(localize('com_auth_vectoree_reset_missing'));
      return;
    }
    if (password.length < 8) {
      setMessage(localize('com_auth_vectoree_password_min'));
      return;
    }
    if (password.length > 128) {
      setMessage(localize('com_auth_password_max_length'));
      return;
    }
    if (password !== confirm) {
      setMessage(localize('com_auth_password_not_match'));
      return;
    }
    setSubmitting(true);
    setMessage(null);
    setWalletBillingUrl(null);
    try {
      const reset = await submitVectoreeAppAuth({
        action: 'reset-password',
        password,
        otp: token,
      });
      if (reset.billingUrl) {
        setWalletBillingUrl(reset.billingUrl);
        return;
      }
      if (!reset.ok) {
        throw new Error(reset.message || localize('com_auth_vectoree_reset_failed'));
      }
      setHeaderText('com_auth_reset_password_success');
      setDone(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : localize('com_auth_error_invalid_reset_token'));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Alert variant="success" icon={false} className="mt-6 px-6 py-4 shadow-sm transition-all">
        <div className="flex flex-col space-y-4">
          <p>{localize('com_auth_login_with_new_password')}</p>
          <Button onClick={() => navigate('/login')} aria-label={localize('com_auth_sign_in')} variant="submit">
            {localize('com_auth_continue')}
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <form className="mt-6" aria-label="Password reset form" method="POST" onSubmit={onSubmit}>
      {walletBillingUrl ? <VectoreeWalletNotice href={walletBillingUrl} /> : null}
      {message ? (
        <p role="alert" className="mb-4 text-sm text-text-destructive">
          {message}
        </p>
      ) : null}
      {!token ? <p className="mb-4 text-sm text-text-secondary">{localize('com_auth_vectoree_reset_missing')}</p> : null}
      <div className="mb-2">
        <SecretInput
          id="password"
          autoComplete="new-password"
          aria-label={localize('com_auth_password')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={authInputClassName}
          placeholder=" "
          label={localize('com_auth_password')}
          labelClassName={authLabelClassName}
          controlsClassName="right-2"
          buttonClassName={authSecretButtonClassName}
          minLength={8}
          maxLength={128}
        />
      </div>
      <div className="mb-2">
        <SecretInput
          id="confirm_password"
          aria-label={localize('com_auth_password_confirm')}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className={authInputClassName}
          placeholder=" "
          label={localize('com_auth_password_confirm')}
          minLength={8}
          maxLength={128}
          labelClassName={authLabelClassName}
          controlsClassName="right-2"
          buttonClassName={authSecretButtonClassName}
        />
      </div>
      <div className="mt-6">
        <Button
          type="submit"
          aria-label={localize('com_auth_submit_registration')}
          disabled={submitting || !token}
          variant="submit"
          className="h-12 w-full rounded-2xl"
        >
          {submitting ? <Spinner /> : localize('com_auth_continue')}
        </Button>
      </div>
    </form>
  );
}

export default ResetPassword;
