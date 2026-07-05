import { Workflow } from 'lucide-react'

export default function Flows() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b px-4 py-3 md:px-6">
        <h1 className="shrink-0 text-lg font-semibold md:text-xl">Flows</h1>
      </header>
      <main className="p-4 md:p-6">
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
          <Workflow className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">Data-sourcing flows</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              A graphical editor for how metadata, images, and schedule matches
              are sourced will live here.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
