/** Widest screen laid out as mobile — must match the
 * `@media (max-width: 768px)` blocks in layout.css, markdown.css and
 * markdown-fallback.css. */
const MOBILE_MAX_WIDTH = 768;

/** Whether the window currently gets the mobile layout (sidebars as
 * overlays). Browser only. */
export function isMobileWidth(): boolean {
	return window.innerWidth <= MOBILE_MAX_WIDTH;
}
