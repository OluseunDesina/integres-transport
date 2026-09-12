import { Dialog } from '@angular/cdk/dialog';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  TemplateRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import {
  Alert,
  Button,
  CONFIRM_DIALOG_TITLE_ID,
  ConfirmDialog,
  EmptyState,
  FormSection,
  PageHeader,
  Paginator,
  Select,
  StatusPill,
  Table,
  TextField,
  summaryLine,
} from '@shared-ui';
import type { ConfirmDialogData, ConfirmDialogResult, SelectOption, StatusPillTone } from '@shared-ui';
import { toDataURL } from 'qrcode';

import { TapCredentialStore, type TapCredential } from '../shared/data/store/tap-credential.store';

type Channel = TapCredential['channel'];

const CHANNEL_OPTIONS: SelectOption[] = [
  { value: 'qr', label: 'QR code' },
  { value: 'nfc', label: 'NFC' },
];

const CHANNEL_LABEL: Record<TapCredential['channel'], string> = {
  qr: 'QR code',
  nfc: 'NFC',
};

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string') {
      return detail;
    }
    for (const value of Object.values(error as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0];
      }
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return fallback;
}

/**
 * The passenger's tap-and-go credentials — the customer-app UI named as
 * still-open in docs/specs/4b-tap-and-go.md's own "Implementation note
 * (backend, done)". No backend change was needed: `POST
 * /tap-credentials/`, `GET /tap-credentials/mine/`, and `PATCH
 * /tap-credentials/{id}/` were already built and documented as
 * "customer-app-consumable" the whole time.
 *
 * The issued `token` is shown exactly once, right here, the moment
 * issuance succeeds — the backend never lets it be re-fetched (only its
 * SHA-256 hash is stored). `issuedCredential`/`qrDataUrl` are plain
 * component signals, not persisted anywhere: a page refresh loses the
 * reveal, which is correct — that's the same guarantee the backend
 * itself makes.
 */
@Component({
  selector: 'app-my-credentials',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    Alert,
    Button,
    EmptyState,
    FormSection,
    PageHeader,
    Paginator,
    Select,
    StatusPill,
    Table,
    TextField,
  ],
  templateUrl: './my-credentials.html',
})
export class MyCredentials implements OnInit {
  protected readonly store = inject(TapCredentialStore);
  private readonly fb = inject(FormBuilder);
  private readonly dialog = inject(Dialog);
  private readonly api = inject(API_CLIENT);

  @ViewChild('revokeBody') private readonly revokeBody!: TemplateRef<unknown>;

  protected readonly channelOptions = CHANNEL_OPTIONS;
  protected readonly channelLabel = CHANNEL_LABEL;

  protected readonly form = this.fb.nonNullable.group({
    channel: this.fb.nonNullable.control<Channel>('qr'),
    label: this.fb.nonNullable.control(''),
  });

  protected readonly issuing = signal(false);
  protected readonly issueError = signal<string | null>(null);
  protected readonly issuedCredential = signal<{ token: string; label: string } | null>(null);
  protected readonly qrDataUrl = signal<string | null>(null);

  protected readonly confirmDisabled = computed(() => false);
  protected readonly danger = computed(() => true);
  protected readonly confirmLabel = computed(() => 'Revoke credential');

  ngOnInit(): void {
    void this.store.getAll();
  }

  protected onPageChange(offset: number): void {
    void this.store.changePage(offset);
  }

  protected statusTone(credential: TapCredential): StatusPillTone {
    return credential.is_active ? 'positive' : 'neutral';
  }

  protected statusLabel(credential: TapCredential): string {
    return credential.is_active ? 'Active' : 'Revoked';
  }

  /** The columns hidden below `md`, re-flowed under the channel. */
  protected summaryFor(credential: TapCredential): string {
    return summaryLine([
      credential.label || 'No name',
      new Date(credential.created_at).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    ]);
  }

  /** Every active row renders a button reading "Revoke", so without
   * this a screen reader announces the same thing for all of them. */
  protected revokeLabel(credential: TapCredential): string {
    return `Revoke ${credential.label || CHANNEL_LABEL[credential.channel]} credential`;
  }

  protected async onIssue(): Promise<void> {
    this.issueError.set(null);
    this.issuing.set(true);

    const { data, error } = await this.api.POST('/api/v1/tap-credentials/', {
      body: this.form.getRawValue(),
    });

    this.issuing.set(false);

    if (!data) {
      this.issueError.set(extractFirstErrorMessage(error, 'Could not issue a credential. Try again.'));
      return;
    }

    this.issuedCredential.set({ token: data.token, label: data.label });
    this.qrDataUrl.set(await this.generateQrDataUrl(data.token));
    this.form.reset({ channel: 'qr', label: '' });
    void this.store.getAll();
  }

  protected dismissReveal(): void {
    this.issuedCredential.set(null);
    this.qrDataUrl.set(null);
  }

  protected revoke(credential: TapCredential): void {
    const ref = this.dialog.open<boolean, ConfirmDialogData>(ConfirmDialog, {
      ariaModal: true,
      ariaLabelledBy: CONFIRM_DIALOG_TITLE_ID,
      data: {
        title: `Revoke credential — ${credential.label || this.channelLabel[credential.channel]}`,
        bodyTemplate: this.revokeBody,
        confirmLabel: this.confirmLabel,
        danger: this.danger,
        confirmDisabled: this.confirmDisabled,
        onConfirm: () => this.submitRevoke(credential.id),
      },
    });

    // Deferred one tick — see my-bookings.ts's identical reasoning:
    // refetching in the same synchronous tick as the dialog's own
    // close/focus-restoration sequence races it and drops focus.
    ref.closed.subscribe(() => {
      setTimeout(() => void this.store.getAll());
    });
  }

  // Isolated for testability — spied on in specs so unit tests don't
  // exercise the real QR-encoding library, same isolation-for-testing
  // convention my-bookings.ts used for redirectToPaystack().
  //
  // 340, not 220 — see booking-tickets.ts's identical comment: Senior
  // Mode (spec 21 slice 3) displays this at a larger CSS size via
  // `--ui-qr-size`, and generating the source at that resolution up
  // front avoids upscaling a blurry 220px PNG.
  protected async generateQrDataUrl(token: string): Promise<string> {
    return toDataURL(token, { width: 340, margin: 1 });
  }

  private async submitRevoke(id: string): Promise<ConfirmDialogResult> {
    const { error } = await this.api.PATCH('/api/v1/tap-credentials/{id}/', {
      params: { path: { id } },
      body: { is_active: false },
    });

    return error
      ? {
          ok: false,
          error: extractFirstErrorMessage(error, 'Could not revoke this credential. Try again.'),
        }
      : { ok: true };
  }
}
