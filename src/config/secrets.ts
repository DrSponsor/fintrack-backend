import type { AppConfig } from './index'

export type SecretName =
  | 'FIELD_ENCRYPTION_KEY_BASE64'
  | 'JWT_PUBLIC_KEY_PEM'
  | 'JWT_PRIVATE_KEY_PEM'

export interface SecretsProvider {
  getSecret(name: SecretName): Promise<string | undefined>
  refresh(): Promise<void>
}

export class EnvironmentSecretsProvider implements SecretsProvider {
  public constructor(private readonly appConfig: AppConfig) {}

  public getSecret(name: SecretName): Promise<string | undefined> {
    switch (name) {
      case 'FIELD_ENCRYPTION_KEY_BASE64':
        return Promise.resolve(this.appConfig.fieldEncryptionKeyBase64)
      case 'JWT_PUBLIC_KEY_PEM':
        return Promise.resolve(this.appConfig.jwtPublicKeyPem)
      case 'JWT_PRIVATE_KEY_PEM':
        return Promise.resolve(this.appConfig.jwtPrivateKeyPem)
      default: {
        const exhaustive: never = name
        return Promise.resolve(exhaustive)
      }
    }
  }

  public refresh(): Promise<void> {
    return Promise.resolve()
  }
}
