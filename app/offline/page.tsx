/**
 * The offline fallback the service worker serves when a navigation cannot
 * reach the network (Requirement 15.1).
 *
 * Deliberately static and session-free: it is precached at install time, so it
 * must not depend on cookies, the services, or anything that varies per user.
 */
export const dynamic = "force-static";

export const metadata = {
  title: "Offline — Load Energy",
};

export default function OfflinePage() {
  return (
    <main className="shell-main">
      <h1>No connection</h1>
      <p className="lede">
        Load Energy needs signal to post a load, quote, or record a BOL. Nothing
        you entered was sent.
      </p>
      <div className="card">
        <h2 className="card-title">When you are back on</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: "1.25rem" }}>
          <li>Buyers: re-check quotes before accepting — holds expire.</li>
          <li>Suppliers: refresh the RFQ inbox; stale loads drop off.</li>
        </ul>
      </div>
      <a className="btn btn-primary btn-block" href="/">
        Try again
      </a>
    </main>
  );
}
