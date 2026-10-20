declare module "semver" {
  const semver: {
    valid(v: string): string | null;
    maxSatisfying(versions: string[], range: string): string | null;
    satisfies(version: string, range: string): boolean;
  };
  export default semver;
}
