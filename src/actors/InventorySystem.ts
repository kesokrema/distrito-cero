export type Weapon = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'charge';
export type Firearm = Exclude<Weapon, 'fists' | 'charge'>;
export type PickupKind = 'smg' | 'pistolAmmo' | 'smgAmmo' | 'shotgunAmmo' | 'rifleAmmo' | 'medkit' | 'armor' | 'supply' | 'charge';

export const weaponCapacity: Record<Firearm, number> = { pistol: 12, smg: 30, shotgun: 8, rifle: 24 };

export class InventorySystem {
  weapon: Weapon = 'pistol';
  readonly unlocked = new Set<Weapon>(['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'charge']);
  readonly magazine: Record<Firearm, number> = { pistol: 12, smg: 30, shotgun: 8, rifle: 24 };
  readonly reserve: Record<Firearm, number> = { pistol: 36, smg: 90, shotgun: 32, rifle: 72 };
  medkits = 1;
  armor = 0;
  charges = Infinity;
  supplies = 0;
  delivered = false;

  select(slot: number): Weapon | null {
    const choice: Weapon[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'charge'];
    const weapon = choice[slot - 1];
    if (!weapon || !this.unlocked.has(weapon)) return null;
    this.weapon = weapon;
    return weapon;
  }

  pickup(kind: PickupKind): string {
    switch (kind) {
      case 'smg':
        this.reserve.smg += 60;
        return '+60 MUNICIONES DE SUBFUSIL';
      case 'pistolAmmo': this.reserve.pistol += 24; return '+24 MUNICIONES DE PISTOLA';
      case 'smgAmmo': this.reserve.smg += 60; return '+60 MUNICIONES DE SUBFUSIL';
      case 'shotgunAmmo': this.reserve.shotgun += 16; return '+16 CARTUCHOS DE ESCOPETA';
      case 'rifleAmmo': this.reserve.rifle += 48; return '+48 MUNICIONES DE FUSIL';
      case 'medkit': this.medkits++; return 'BOTIQUÍN AÑADIDO';
      case 'armor': this.armor = Math.min(100, this.armor + 45); return 'CHALECO EQUIPADO';
      case 'charge': return 'MISILES DE BAZUCA ILIMITADOS';
      case 'supply': this.supplies++; return `SUMINISTROS ${this.supplies}/3`;
    }
  }

  useMedkit(health: number): number | null {
    if (this.medkits < 1 || health >= 100) return null;
    this.medkits--;
    return Math.min(100, health + 45);
  }

  reload(): boolean {
    if (this.weapon === 'fists' || this.weapon === 'charge') return false;
    const capacity = weaponCapacity[this.weapon];
    const missing = capacity - this.magazine[this.weapon];
    const amount = Math.min(missing, this.reserve[this.weapon]);
    if (amount <= 0) return false;
    this.magazine[this.weapon] += amount;
    this.reserve[this.weapon] -= amount;
    return true;
  }

  get ammoLabel(): string {
    if (this.weapon === 'fists') return 'CUERPO A CUERPO';
    if (this.weapon === 'charge') return '∞ MISILES';
    return `${this.magazine[this.weapon]} / ${this.reserve[this.weapon]}`;
  }
}
