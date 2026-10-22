import {
  Card,
  CardContent,
  CardHeader,
  CardDescription,
} from '@/components/ui/card';
import { LoginForm } from './login-form';

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-5 py-12">
      <a href="/courses" className="brand">
        <span className="brand-mark" aria-hidden="true">
          AV
        </span>
        AIVirTeach
      </a>
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader className="space-y-2">
          <h1 className="text-xl font-semibold">AIVirTeach 运营后台</h1>
          <CardDescription>
            登录管理员账号，继续编写和管理课程。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        课程工作室 · 仅限授权管理员
      </p>
    </main>
  );
}
