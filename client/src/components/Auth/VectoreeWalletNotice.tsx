import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { useLocalize } from '~/hooks';

export default function VectoreeWalletNotice({ href }: { href: string }) {
  const localize = useLocalize();
  return (
    <ErrorMessage>
      <p>
        {localize('com_auth_vectoree_wallet_before')}
        <a href={href} className="font-medium underline">
          {localize('com_auth_vectoree_wallet_link')}
        </a>
        {localize('com_auth_vectoree_wallet_after')}
      </p>
    </ErrorMessage>
  );
}
