/** Original local SVG marks: GitHub silhouette, GitLab fox and a generic pull-request glyph. */
export function ForgeIcon({ forge, size = 16 }: { forge: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={forge === "github" ? "GitHub" : forge === "gitlab" ? "GitLab" : "Git forge"}>
    {forge === "github" ? <path fill="currentColor" d="M12 2a10 10 0 0 0-3 19.5v-2.4c-2.4.5-3-1-3-1-.4-1-1-1.3-1-1.3-.8-.5 0-.5 0-.5.9 0 1.4.9 1.4.9.8 1.4 2 .9 2.6.7.1-.6.3-1 .6-1.2-2-.2-4.2-1-4.2-4.4 0-1 .4-1.8 1-2.4-.1-.3-.4-1.2.1-2.5 0 0 .8-.3 2.7 1a9 9 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.2.1 2.5.6.6 1 1.4 1 2.4 0 3.4-2.2 4.2-4.2 4.4.4.3.7.9.7 1.7v3.1A10 10 0 0 0 12 2Z" /> : forge === "gitlab" ? <><path fill="#e24329" d="m12 22-10-8 3-12 4 9h6l4-9 3 12-10 8Z" /><path fill="#fc6d26" d="m2 14 7-3 3 11L2 14Zm20 0-7-3-3 11 10-8Z" /><path fill="#fca326" d="m9 11 3 11 3-11H9Z" /></> : <g fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10m12 0V9c0-3-2-4-5-4h-2m3-3-3 3 3 3" /></g>}
  </svg>;
}
