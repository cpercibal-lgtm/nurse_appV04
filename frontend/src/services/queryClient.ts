import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './http';

// Shared by the provider and the session store: protected server data must be
// cleared on every sign-out or change of identity/privileges, not only when the
// user clicks the logout button in the application shell.
//
// networkMode "always": the browser's online flag is never trusted to decide whether a request is sent.
// By default react-query pauses a save while the browser says "offline" — nothing is sent, no error is
// shown, the button waits for an "online" event. Safari / WebKit sometimes reports offline wrongly, and
// decision D-1 (http.ts) says there is no offline queue: send the request, show the server's answer or
// "the server could not be reached".
export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { networkMode: 'always' },
    queries: {
      networkMode: 'always',
      staleTime: 60_000,
      // Retry only transient failures; a 4xx answer will not change on retry.
      retry: (count, e) => count < 2 && !(e instanceof ApiError && e.status >= 400 && e.status < 500),
    },
  },
});
