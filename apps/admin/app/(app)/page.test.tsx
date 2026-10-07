import { render, screen } from '@testing-library/react';
import Home from './page';

describe('首页', () => {
  it('渲染运营后台标题', () => {
    render(<Home />);

    expect(
      screen.getByRole('heading', { name: 'AIVirTeach 运营后台' }),
    ).toBeInTheDocument();
  });
});
