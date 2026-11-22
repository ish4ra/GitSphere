# Roadmap

GitSphere's priority is reliable data: correct attribution, honest coverage and sustainable automation on free GitHub resources. Presentation follows from that.

## Delivered in 1.0

- Shared, population-aware geography resolver for all ranking modes (CSC + GeoNames gazetteer, 250 regions).
- Deterministic search partitioning by metric and creation time; exact-star buckets no longer stall discovery.
- Continuous refresh cycles for repositories (stars) and developers (followers).
- Per-country location discovery with fair round-robin scheduling.
- Top Repositories, Top Developers (followers) and Top Contributors (public contributions, rolling 12 months).
- Stable node-ID deduplication, revalidation, rename/transfer/deletion handling.
- Truthful per-country statuses; generated country pages and directories; GitSphere brand.
- Single-writer hourly pipeline, secret guard on all persisted data, stall detection.

## Next

1. **Coverage depth.** Lower the global star and follower floors as completed cycles show spare API budget. Track per-cycle duration in `data/summary.json`.
2. **Contribution discovery.** Add activity-oriented candidate sources (for example recently created repositories per country) so highly active developers in large countries are measured sooner.
3. **Gazetteer review loop.** Publish the most frequent ambiguous and unrecognized locations, so curated aliases can be added from evidence.
4. **History.** Keep compact monthly snapshots of each ranking for trend charts, without growing Git history unnecessarily (e.g. a release asset per month).
5. **Website.** A static, searchable site (GitHub Pages) with interactive maps and country comparisons, generated from `data/`.
6. **Storage.** If state churn grows, move checkpoints to a dedicated data branch so `main` holds only published data.

## Principles

- Never claim completeness beyond what the scans establish.
- Never force ambiguous or unsupported locations into a country.
- No paid services, databases or mandatory paid APIs.
