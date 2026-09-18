'use client';

import { Modal } from '@/components/ui/Modal';
import { Badge, Button } from '@/components/ui/primitives';

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-[var(--border)] px-5 py-4 last:border-b-0">
      <h3 className="text-[10px] font-semibold tracking-[0.1em] text-[var(--text-faint)] uppercase">{title}</h3>
      <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-[var(--text-muted)]">{children}</div>
    </section>
  );
}

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="About this tool"
      description="What it does, what it deliberately does not do."
      footer={
        <Button size="sm" variant="primary" data-autofocus onClick={onClose}>
          Got it
        </Button>
      }
    >
      <Block title="What it does">
        <p>
          Enter a website address and the scanner crawls the pages it is permitted to fetch, parses the
          returned HTML and CSS, and lists every image reference it finds. Nothing is hard-coded: the
          gallery is built entirely from the results of the scan you just ran.
        </p>
      </Block>

      <Block title="Where images are found">
        <div className="flex flex-wrap gap-1.5">
          {[
            'IMG',
            'SRCSET',
            'PICTURE',
            'LAZY ATTR',
            'OG IMAGE',
            'TWITTER CARD',
            'JSON-LD',
            'SITE ICON',
            'CSS INLINE',
            'CSS SHEET',
            'VIDEO POSTER',
            'SVG IMAGE',
            'INPUT IMAGE',
          ].map((label) => (
            <Badge key={label}>{label}</Badge>
          ))}
        </div>
        <p>
          Relative URLs are resolved against the page (honouring <code className="font-mono">&lt;base&gt;</code>),
          fragments are dropped, and tracking parameters are removed before two references are treated as
          the same asset.
        </p>
      </Block>

      <Block title="What the statuses mean">
        <ul className="space-y-1.5">
          <li>
            <strong className="text-[var(--text)]">Available</strong> — the scanner requested the URL and
            received image data.
          </li>
          <li>
            <strong className="text-[var(--text)]">Redirected</strong> — the URL resolved, but through a
            redirect to a different address.
          </li>
          <li>
            <strong className="text-[var(--text)]">Unavailable / Unsupported</strong> — the request failed,
            or the response was not readable image data.
          </li>
          <li>
            <strong className="text-[var(--text)]">Not verified</strong> — the reference exists in the
            markup but the scanner did not request it. Availability is genuinely unknown.
          </li>
          <li>
            <strong className="text-[var(--text)]">Duplicate</strong> — byte-identical (SHA-256) to an
            asset found earlier in the same scan.
          </li>
        </ul>
        <p>Availability is never inferred from a URL simply appearing in HTML.</p>
      </Block>

      <Block title="Categories are heuristics">
        <p>
          Every category is a guess derived from observable signals — filename, alt text, surrounding
          markup, dimensions, discovery method and the page it was found on. They are labelled{' '}
          <em>detected</em> for that reason, and you can change any of them; exports use your choice.
        </p>
      </Block>

      <Block title="What it will not do">
        <ul className="space-y-1.5">
          <li>It does not bypass authentication, paywalls, access controls or anti-bot protection.</li>
          <li>It does not execute JavaScript from scanned pages, so client-rendered images may be missed.</li>
          <li>It refuses non-public destinations: loopback, private ranges, link-local and cloud metadata addresses.</li>
          <li>It follows robots.txt by default, including any Crawl-delay the site asks for.</li>
          <li>It exports references and metadata — never the image files themselves.</li>
        </ul>
        <p>
          Discovering an image says nothing about your right to reuse it. Copyright stays with the
          original owner.
        </p>
      </Block>

      <Block title="Keyboard">
        <ul className="space-y-1.5 font-mono text-[12px]">
          <li>
            <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">/</kbd> focus search
          </li>
          <li>
            <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">←</kbd>{' '}
            <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">→</kbd> previous / next image in the viewer
          </li>
          <li>
            <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5">Esc</kbd> close the viewer or a dialog
          </li>
        </ul>
      </Block>
    </Modal>
  );
}
