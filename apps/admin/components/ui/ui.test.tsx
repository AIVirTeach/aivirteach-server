import { render, screen } from '@testing-library/react';
import { Button } from './button';
import { Card, CardTitle } from './card';
import { Input } from './input';
import { Label } from './label';

describe('基础 UI 组件', () => {
  it('Button 渲染文字，并且 disabled 生效', () => {
    render(<Button disabled>登录</Button>);

    expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
  });

  it('Label 与 Input 通过 htmlFor 关联', () => {
    render(
      <>
        <Label htmlFor="email">邮箱</Label>
        <Input id="email" />
      </>,
    );

    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
  });

  it('Card 渲染子内容和标题', () => {
    render(
      <Card>
        <CardTitle>标题</CardTitle>
        内容
      </Card>,
    );

    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument();
    expect(screen.getByText('内容')).toBeInTheDocument();
  });
});
