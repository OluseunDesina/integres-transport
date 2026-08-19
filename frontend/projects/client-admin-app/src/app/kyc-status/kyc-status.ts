import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { API_CLIENT } from '@api-client';
import type { components } from '@api-client';
import { AuthStore } from '@auth';
import { Alert, Button, Select, StatusPill } from '@shared-ui';

import { DOCUMENT_TYPE_OPTIONS } from '../shared/document-type-options';
import { FileUploadField } from '../shared/file-upload-field';
import { documentReviewStatusTone } from '../shared/status-tone';

type ClientMe = components['schemas']['ClientMe'];

function extractFirstErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
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

@Component({
  selector: 'app-kyc-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Alert, Button, Select, StatusPill, FileUploadField],
  templateUrl: './kyc-status.html',
})
export class KycStatus implements OnInit {
  private readonly api = inject(API_CLIENT);
  private readonly authStore = inject(AuthStore);

  protected readonly documentTypeOptions = DOCUMENT_TYPE_OPTIONS;
  protected readonly documentReviewStatusTone = documentReviewStatusTone;

  protected readonly me = signal<ClientMe | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);

  protected readonly documentType = signal('certificate_of_incorporation');
  protected readonly selectedFile = signal<File | null>(null);
  protected readonly uploading = signal(false);
  protected readonly uploadError = signal<string | null>(null);

  @ViewChild(FileUploadField) private readonly fileField!: FileUploadField;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    const { data, error } = await this.api.GET('/api/v1/clients/me/', {
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });
    this.loading.set(false);

    if (!data) {
      this.loadError.set(extractFirstErrorMessage(error, 'Could not load your KYC status.'));
      return;
    }
    this.me.set(data);
  }

  protected onFileSelected(file: File | null): void {
    this.selectedFile.set(file);
  }

  protected setDocumentType(value: string): void {
    this.documentType.set(value);
  }

  protected async onUpload(): Promise<void> {
    const file = this.selectedFile();
    if (!file) {
      this.uploadError.set('Choose a file to upload.');
      return;
    }

    this.uploading.set(true);
    this.uploadError.set(null);
    const formData = new FormData();
    formData.append('document_type', this.documentType());
    formData.append('file', file);

    const { data, error } = await this.api.POST('/api/v1/clients/me/kyc-documents/', {
      body: formData as unknown as components['schemas']['KycDocument'],
      headers: { Authorization: `Bearer ${this.authStore.accessToken()}` },
    });

    this.uploading.set(false);

    if (!data) {
      this.uploadError.set(extractFirstErrorMessage(error, 'Could not upload this document. Try again.'));
      return;
    }

    this.selectedFile.set(null);
    this.fileField.reset();
    await this.load();
  }
}
