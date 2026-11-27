import { normalizeBaseUrl, normalizeVaultKey, resolveVaultBaseUrl } from "./client.js";

export const VAULT_CAR_KEYS = Object.freeze({
    kolmogorov_hatchback: "cars/kolmogorov_hatchback.glb",
    lexus_is300: "cars/lexus_is300.glb",
    nissan_silvia_s15: "cars/nissan_silvia_s15.glb",
    nissan_skyline_r34: "cars/nissan_skyline_r34.glb",
    toyota_supra_a80: "cars/toyota_supra_a80.glb",
    crotch_rocket: "cars/crotch_rocket.glb",
    starfox_rocket: "cars/starfox_rocket.glb",
} as const);

export const VAULT_WEAPON_KEYS = Object.freeze({
    pistol: "weapons/kolmogorov_pistol.glb",
    smg: "weapons/kolmogorov_smg.glb",
    shotgun: "weapons/kolmogorov_shotgun.glb",
    rpg: "weapons/kolmogorov_rpg.glb",
    kolmogorov_pistol: "weapons/kolmogorov_pistol.glb",
    kolmogorov_smg: "weapons/kolmogorov_smg.glb",
    kolmogorov_shotgun: "weapons/kolmogorov_shotgun.glb",
    kolmogorov_rpg: "weapons/kolmogorov_rpg.glb",
} as const);

export const VAULT_CITY_KEYS = Object.freeze({
    road_straight: "city/R_Straight_6x6.glb",
    road_crosswalk: "city/R_Crosswalk_6x6.glb",
    road_intersection: "city/R_Intersection_6x6.glb",
    curb_straight: "city/S_Straight_3x6.glb",
    curb_ramp: "city/S_AccessibleRamp_3x6.glb",
    curb_driveway: "city/S_Driveway_3x6.glb",
    light_pole: "city/L_LightPole_12gon.glb",
    gas_canopy: "city/gas-canopy-roof.glb",
    gas_pump_twin: "city/gas-pump-twin.glb",
    neon_petro_sign: "city/neon-petro-sign.glb",
    door_hinged_single: "city/door_hinged_single_900x2100.glb",
    roof_gable_3x3: "city/roof_gable_3x3.glb",
    prop_arcade_cabinet: "city/prop_arcade_cabinet.glb",
} as const);

function mapKeysToUrls<T extends Record<string, string>>(keys: T, root: string): Readonly<Record<keyof T, string>> {
    const out = {} as Record<keyof T, string>;
    for (const [id, key] of Object.entries(keys) as Array<[keyof T, string]>) {
        out[id] = `${root}/assets/${normalizeVaultKey(key)}`;
    }
    return Object.freeze(out);
}

export function createVaultCatalog(baseUrl = resolveVaultBaseUrl()) {
    const root = normalizeBaseUrl(baseUrl);
    const cars = mapKeysToUrls(VAULT_CAR_KEYS, root);
    const weapons = mapKeysToUrls(VAULT_WEAPON_KEYS, root);
    const city = mapKeysToUrls(VAULT_CITY_KEYS, root);
    return Object.freeze({ cars, weapons, city });
}

const DEFAULT_CATALOG = createVaultCatalog();

export const VAULT_CARS = DEFAULT_CATALOG.cars;
export const VAULT_WEAPONS = DEFAULT_CATALOG.weapons;
export const VAULT_CITY = DEFAULT_CATALOG.city;
export const VAULT_CATALOG = DEFAULT_CATALOG;

export type VaultCarId = keyof typeof VAULT_CARS;
export type VaultWeaponId = keyof typeof VAULT_WEAPONS;
export type VaultCityId = keyof typeof VAULT_CITY;
export type VaultCatalog = ReturnType<typeof createVaultCatalog>;

export function vaultAssetUrl(key: string, baseUrl = resolveVaultBaseUrl()): string {
    return `${normalizeBaseUrl(baseUrl)}/assets/${normalizeVaultKey(key)}`;
}
