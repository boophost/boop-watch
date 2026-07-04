import { PortalLayout } from '@/components/PortalLayout'

export default function PersonalLibrary() {
  return (
    <PortalLayout>
      <main>
        <section className="home-section">
          <div className="section-head">
            <div className="h-eyebrow">Your Collection</div>
            <h1 className="k-h1">Personal Library</h1>
          </div>
          <div className="empty" style={{ marginTop: '2rem' }}>
            <p>You haven't saved any titles yet. (Coming soon!)</p>
          </div>
        </section>
      </main>
    </PortalLayout>
  )
}
