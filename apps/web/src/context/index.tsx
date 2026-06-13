import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RouterProvider } from "./router";
import { RunDialogProvider } from "./run-dialog";
import { ToastProvider } from "./toast";
import { UIProvider } from "./ui";

export * from "./router";
export * from "./ui";
export * from "./toast";
export * from "./run-dialog";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

/**
 * The full provider stack for the app. Order matters: RunDialog depends on the
 * router + toasts, which depend on the query client.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <UIProvider>
          <ToastProvider>
            <RunDialogProvider>{children}</RunDialogProvider>
          </ToastProvider>
        </UIProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}
