import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { HasPermissionDirective, PermissionsService } from '@auth';
import {
  Alert,
  Button,
  EmptyState,
  FormSection,
  PageHeader,
  Select,
  StatusPill,
  Tabs,
  TextField,
} from '@shared-ui';
import type { TabItem } from '@shared-ui';

import { BusinessStore, type Business } from '../../shared/data/store/business.store';
import { extractFirstErrorMessage } from '../../shared/error-message';
import { applyServerErrors, clearServerErrors, fieldErrorMessage } from '../../shared/form-errors';
import {
  CERTIFICATE_GUIDANCE,
  ID_GENERAL_GUIDANCE,
  ID_TYPE_GUIDANCE,
  ID_TYPE_OPTIONS,
  OTHER_GUIDANCE,
  PROOF_OF_ADDRESS_GUIDANCE,
  TAX_CERTIFICATE_GUIDANCE,
} from '../../shared/kyb-guidance';
import { documentReviewStatusTone } from '../../shared/status-tone';

type Director = components['schemas']['Director'];
type KybDocument = components['schemas']['KybDocument'];

/** The four company-level document slots, in the order the screen shows
 * them. `directors_id` is deliberately absent — those belong to a
 * director row, not to a standalone slot. */
const COMPANY_SECTIONS = [
  {
    type: 'certificate_of_incorporation',
    title: 'Certificate of incorporation',
    guidance: CERTIFICATE_GUIDANCE,
  },
  {
    type: 'proof_of_address',
    title: 'Proof of address',
    guidance: PROOF_OF_ADDRESS_GUIDANCE,
  },
  {
    type: 'tax_certificate',
    title: 'Tax certificate',
    guidance: TAX_CERTIFICATE_GUIDANCE,
  },
  {
    type: 'other',
    title: 'Other supporting documents',
    guidance: OTHER_GUIDANCE,
  },
] as const;

/**
 * The KYB screen — docs/specs/11-kyb-directors.md.
 *
 * Replaces the block that used to hang off the bottom of the business
 * edit form: one document-type `<select>` and one file input, through
 * which every required document went in undifferentiated, with no way
 * to see what had already been supplied or what a valid document looks
 * like. Director identity had nowhere to live at all.
 *
 * Its own route rather than a section of `business-form` because it is
 * a distinct task — an operator gathering paperwork over days, not a
 * field edit — and because a `:id/kyb` URL is bookmarkable and
 * shareable within a team, which a scroll position is not.
 */
@Component({
  selector: 'app-business-kyb',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    HasPermissionDirective,
    Alert,
    FormSection,
    PageHeader,
    Tabs,
    Button,
    EmptyState,
    Select,
    StatusPill,
    TextField,
  ],
  templateUrl: './business-kyb.html',
})
export class BusinessKyb implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(API_CLIENT);
  private readonly permissions = inject(PermissionsService);
  private readonly store = inject(BusinessStore);

  protected readonly companySections = COMPANY_SECTIONS;
  protected readonly idTypeOptions = ID_TYPE_OPTIONS;
  protected readonly idGeneralGuidance = ID_GENERAL_GUIDANCE;
  protected readonly kybStatusTone = documentReviewStatusTone;

  protected readonly businessId = signal<string>('');
  protected readonly business = signal<Business | null>(null);
  protected readonly notFound = signal(false);
  protected readonly loading = signal(true);
  protected readonly errorMessage = signal<string | null>(null);

  /** Directors and company documents are two unrelated halves of one
   * record, both already loaded before either renders — the model
   * `ui-tabs` is built for. Stacked, this was the longest screen in the
   * console and the company documents sat below four director cards
   * plus an add form. */
  protected readonly tabs: TabItem[] = [
    { id: 'directors', label: 'Directors' },
    { id: 'documents', label: 'Company documents' },
  ];
  protected readonly activeTab = signal('directors');

  protected setActiveTab(id: string): void {
    this.activeTab.set(id);
  }

  protected readonly directors = signal<Director[]>([]);
  protected readonly documents = signal<KybDocument[]>([]);

  protected readonly canManage = computed(() => this.permissions.has('business.manage'));

  /** Which single upload is in flight, so only that section's button
   * shows a pending state rather than the whole page locking. */
  protected readonly uploading = signal<string | null>(null);
  private readonly pendingFiles = new Map<string, File>();

  protected readonly addingDirector = signal(false);
  protected readonly directorForm = this.fb.nonNullable.group({
    full_name: ['', Validators.required],
    id_type: ['nin', Validators.required],
    id_number: [''],
  });

  /** Only active directors get a row; a soft-removed one stays in the
   * record (and in the reviewer's queue) but is not offered for new
   * uploads. */
  protected readonly activeDirectors = computed(() =>
    this.directors().filter((director) => director.is_active !== false)
  );

  protected readonly idGuidance = computed(
    () => ID_TYPE_GUIDANCE[this.directorForm.controls.id_type.value] ?? ''
  );

  /** The human label for a stored `id_type`. Rendering the raw enum
   * showed operators `nin` and `drivers_licence` where the form that
   * created them offered "National Identification Number (NIN)" — the
   * same list, spelled two different ways on one screen. */
  protected idTypeLabel(idType: string): string {
    return ID_TYPE_OPTIONS.find((option) => option.value === idType)?.label ?? idType;
  }

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.businessId.set(id);

    // Same lookup as BusinessForm's: there is no GET /businesses/{id}/,
    // so resolve through the store's full-list paging lookup. NOT one
    // bounded page plus `.find()` — that silently 404s any Business past
    // row 25, which is what this screen originally shipped with.
    const business = await this.store.findById(id);
    if (!business) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.business.set(business);
    await Promise.all([this.loadDirectors(), this.loadDocuments()]);
    this.loading.set(false);
  }

  // --- reads -------------------------------------------------------------

  private async loadDirectors(): Promise<void> {
    const { data, error } = await this.api.GET('/api/v1/businesses/{business_id}/directors/', {
      params: {
        path: { business_id: this.businessId() },
        query: { limit: 100, offset: 0 },
      },
    });
    if (!data) {
      this.errorMessage.set(extractFirstErrorMessage(error, 'Could not load directors.'));
      return;
    }
    this.directors.set(data.results);
  }

  private async loadDocuments(): Promise<void> {
    const { data, error } = await this.api.GET('/api/v1/businesses/{business_id}/kyb-documents/', {
      params: { path: { business_id: this.businessId() } },
    });
    if (!data) {
      this.errorMessage.set(extractFirstErrorMessage(error, 'Could not load documents.'));
      return;
    }
    this.documents.set(data);
  }

  // --- derived state used by the template ---------------------------------

  /** Documents already supplied for a company-level slot. Several are
   * allowed per slot ("other" especially), so this is a list, not one. */
  protected documentsFor(documentType: string): KybDocument[] {
    return this.documents().filter((d) => d.document_type === documentType && !d.director);
  }

  protected documentsForDirector(directorId: string): KybDocument[] {
    return this.documents().filter((d) => d.director === directorId);
  }

  protected fileName(document: KybDocument): string {
    return document.file.split('/').pop() ?? document.file;
  }

  // --- directors ---------------------------------------------------------

  /** `ui-text-field`/`ui-select` do not read their control's validity —
   * they render an error only when the parent binds `[invalid]` and
   * `[errorMessage]`. This screen originally bound neither, so pressing
   * "Add director" with an empty name silently did nothing: the form was
   * invalid, `markAllAsTouched()` ran, and no message appeared anywhere.
   * Same helper shape as `business-form.ts`'s own. */
  protected fieldError(field: 'full_name' | 'id_type' | 'id_number'): string | null {
    return fieldErrorMessage(this.directorForm.controls[field]);
  }

  protected async addDirector(): Promise<void> {
    if (this.directorForm.invalid) {
      this.directorForm.markAllAsTouched();
      return;
    }
    this.addingDirector.set(true);
    this.errorMessage.set(null);
    clearServerErrors(this.directorForm);

    const { data, error } = await this.api.POST('/api/v1/businesses/{business_id}/directors/', {
      params: { path: { business_id: this.businessId() } },
      body: this.directorForm.getRawValue() as Director,
    });
    this.addingDirector.set(false);

    if (!data) {
      this.errorMessage.set(
        applyServerErrors(this.directorForm, error, 'Could not add this director.', {
          unplaceable: [],
        })
      );
      return;
    }
    this.directorForm.reset({ full_name: '', id_type: 'nin', id_number: '' });
    await this.loadDirectors();
  }

  /** Soft-remove. Never a delete: a director attached to a submitted or
   * approved packet must stay in the record. */
  protected async removeDirector(director: Director): Promise<void> {
    this.errorMessage.set(null);
    const { error } = await this.api.PATCH('/api/v1/directors/{id}/', {
      params: { path: { id: director.id } },
      body: { is_active: false } as Director,
    });
    if (error) {
      this.errorMessage.set(
        extractFirstErrorMessage(error, `Could not remove ${director.full_name}.`)
      );
      return;
    }
    await this.loadDirectors();
  }

  // --- uploads -----------------------------------------------------------

  /** Keyed by section: a company document_type, or `director:<id>`. One
   * pending file per section, so two sections can be filled before
   * either is submitted. */
  protected onFileSelected(key: string, event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    if (file) {
      this.pendingFiles.set(key, file);
    } else {
      this.pendingFiles.delete(key);
    }
  }

  protected hasPendingFile(key: string): boolean {
    return this.pendingFiles.has(key);
  }

  protected async upload(key: string, documentType: string, directorId?: string): Promise<void> {
    const file = this.pendingFiles.get(key);
    if (!file) {
      this.errorMessage.set('Choose a file to upload.');
      return;
    }
    this.uploading.set(key);
    this.errorMessage.set(null);

    const formData = new FormData();
    formData.append('document_type', documentType);
    formData.append('file', file);
    if (directorId) {
      formData.append('director', directorId);
    }

    const { data, error } = await this.api.POST('/api/v1/businesses/{business_id}/kyb-documents/', {
      params: { path: { business_id: this.businessId() } },
      body: formData as unknown as KybDocument,
    });
    this.uploading.set(null);

    if (!data) {
      this.errorMessage.set(extractFirstErrorMessage(error, 'Could not upload this document.'));
      return;
    }
    this.pendingFiles.delete(key);
    // Uploading moves a pending/rejected Business to `submitted`, so the
    // status pill at the top has to be refreshed too, not just the list.
    // `getAll()` first so the list screen behind this one is current, then
    // `findById` — which reads that same just-refreshed page when the
    // Business is on it, and pages the full list when it isn't. Reading
    // `items()` directly here left the pill stale for any Business past
    // row 25, the same bounded-lookup defect fixed in ngOnInit above.
    await Promise.all([this.loadDocuments(), this.store.getAll()]);
    const refreshed = await this.store.findById(this.businessId());
    if (refreshed) {
      this.business.set(refreshed);
    }
  }
}
