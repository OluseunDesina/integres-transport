import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

import { deriveRamp, onColorFor, parseHex, RAMP_STEPS } from './color';

/**
 * The one colour a tenant supplies. Deliberately a local shape rather
 * than `@auth`'s white-label response type — `@shared-ui` does not depend
 * on `@auth`, and each app composes the two in its own `app.config.ts`.
 */
export interface BrandColors {
  primary?: string | null;
}

/** The darkest ink, used when white is too weak to sit on a tenant's brand. */
const FALLBACK_ON_PRIMARY = '#0f172a';

/**
 * Applies a white-labelled tenant's brand colour at runtime.
 *
 * `WhiteLabelConfig` has stored `primary_color` since Phase 1 and
 * `GET /white-label/resolve/` has always returned it, but nothing in any
 * app ever read it — for a platform whose premise is white-labeled
 * tenants, the branding simply never reached the screen. This is what
 * closes that (docs/specs/14-design-system-and-ui-rebuild.md).
 *
 * It works by overriding the `--color-brand-*` custom properties on the
 * document element. Every semantic role in `theme.css` is aliased to one
 * of those with `var()`, so overriding the ramp cascades through
 * `--color-primary`, `--color-focus` and the rest without this service
 * needing to know they exist.
 */
@Injectable({ providedIn: 'root' })
export class BrandThemeService {
  private readonly document = inject(DOCUMENT);

  /**
   * No-ops on anything that is not plainly a hex colour, leaving the
   * default identity in place.
   *
   * This is the only point in the frontend where tenant-controlled data
   * becomes style, so the value is parsed rather than interpolated —
   * `parseHex` accepts `#RGB`/`#RRGGBB` and nothing else.
   */
  apply(brand: BrandColors | null | undefined): void {
    const seed = brand?.primary ? parseHex(brand.primary) : null;
    if (!seed) {
      return;
    }

    const root = this.document.documentElement;
    const ramp = deriveRamp(seed);
    for (const step of RAMP_STEPS) {
      root.style.setProperty(`--color-brand-${step}`, ramp[step]);
    }

    // The brand becomes the primary action fill, so whatever sits on it
    // must stay legible. White unless white fails AA against the tenant's
    // own colour, in which case the darkest ink. A white-label platform
    // that lets a tenant make their own product unreadable has no
    // accessibility story.
    const onPrimary = onColorFor(seed, parseHex(FALLBACK_ON_PRIMARY)!);
    root.style.setProperty(
      '--color-on-primary',
      onPrimary.r === 255 && onPrimary.g === 255 && onPrimary.b === 255
        ? '#ffffff'
        : FALLBACK_ON_PRIMARY
    );
  }

  /** Drops every override, restoring the default identity. */
  reset(): void {
    const root = this.document.documentElement;
    for (const step of RAMP_STEPS) {
      root.style.removeProperty(`--color-brand-${step}`);
    }
    root.style.removeProperty('--color-on-primary');
  }
}
