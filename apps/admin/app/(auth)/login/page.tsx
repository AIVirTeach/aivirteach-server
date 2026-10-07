import { Card, CardTitle } from '@/components/ui/card';
import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm items-center p-4">
      <Card className="w-full space-y-4 p-6">
        <CardTitle>AIVirTeach 运营后台</CardTitle>
        <LoginForm />
      </Card>
    </main>
  );
}
