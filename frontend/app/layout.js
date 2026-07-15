import './globals.css';

export const metadata = {
  title: 'รายงาน X-ray',
};

export default function RootLayout({ children }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
