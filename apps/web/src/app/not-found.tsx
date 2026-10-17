import Link from 'next/link';

export default function NotFound() {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 max-w-xl text-[15px]">
        There is nothing at this address. The quickstart may not be tracked, or the link is wrong.
      </p>
      <p className="mt-4">
        <Link href="/" className="underline underline-offset-2">
          Back to all quickstarts
        </Link>
      </p>
    </>
  );
}
