import express, { Request, Response } from 'express';
import cors from 'cors';
import { searchMovies, extractShortlinks, bypassModpro, extractDriveSeed } from './scraper';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Helper function from the original Next.js route
async function processPost(postUrl: string, type: 'movie' | 'tv', movieTitle: string, season?: number) {
    console.log(`[CineXP Pipeline] Post URL found: ${postUrl}. Extracting shortlinks...`);
    const shortLinks = await extractShortlinks(postUrl, type, season);
    
    if (shortLinks.length === 0) {
        return [];
    }

    const safeTitleBase = movieTitle.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '-');
    return shortLinks.map(link => {
        const cleanLabel = link.label.replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
        const finalFilename = `${safeTitleBase}-${cleanLabel}_CineXP.mkv`;
        
        // Build the proxy download URL using this server's host/origin when called
        return {
            label: link.label,
            // The URL path is absolute, the frontend will prepend the Render URL
            proxyDownloadUrl: `/api/media/resolve?url=${encodeURIComponent(link.url)}&filename=${encodeURIComponent(finalFilename)}`,
            season: season
        };
    });
}

// GET /api/media/sources
app.get('/api/media/sources', async (req: Request, res: Response) => {
    const title = req.query.title as string;
    const year = (req.query.year as string) || "";
    const type = (req.query.type as string) || "movie"; // "movie" or "tv"
    const industry = (req.query.industry as string) || "hollywood"; // "bollywood" or "hollywood"
    const quality = (req.query.quality as string) || "1080p";
    const season = req.query.season ? Number(req.query.season) : undefined;
    const seasons = req.query.seasons as string | undefined;

    if (!title) {
        return res.status(400).json({ error: "Missing title parameter" });
    }

    try {
        const targetDomain = industry.toLowerCase() === 'bollywood' ? 'moviesleech.link' : 'moviesmod.farm';

        console.log(`[CineXP Pipeline] Starting search for ${title} ${year} on ${targetDomain}`);
        
        let allLinks: any[] = [];
        
        if (type === 'tv' && seasons) {
            // seasons can be "1:2018,2:2020,3:2024" (season:year pairs) or just "1,2,3"
            const seasonEntries = seasons.split(',').map(entry => {
                if (entry.includes(':')) {
                    const [s, y] = entry.split(':');
                    return { season: s, year: y };
                }
                return { season: entry, year };
            });
            console.log(`[CineXP Pipeline] Scraping multiple seasons:`, seasonEntries.map(e => `S${e.season}(${e.year})`).join(', '));
            
            if (targetDomain === 'moviesmod.farm') {
                // Moviesmod: ALL seasons are on ONE page. Search once, extract per-season with targetSeason filter.
                let postUrl = await searchMovies(title, year, 'tv', 'moviesmod.farm');
                if (!postUrl) {
                    // Fallback: try moviesleech per-season if moviesmod search fails entirely
                    console.log(`[CineXP Pipeline] Moviesmod search failed, falling back to moviesleech per-season...`);
                    const results = await Promise.all(seasonEntries.map(async ({ season: s, year: seasonYear }) => {
                        const leechUrl = await searchMovies(title, seasonYear, 'tv', 'moviesleech.link', s);
                        if (leechUrl) return processPost(leechUrl, 'tv', title, Number(s));
                        return [];
                    }));
                    allLinks = results.flat();
                } else {
                    // Found the multi-season page — extract each season's links from the same page
                    const results = await Promise.all(seasonEntries.map(async ({ season: s }) => {
                        return processPost(postUrl!, 'tv', title, Number(s));
                    }));
                    allLinks = results.flat();
                }
            } else {
                // MoviesLeech: each season has its OWN page with a unique URL. Search per-season.
                const results = await Promise.all(seasonEntries.map(async ({ season: s, year: seasonYear }) => {
                    let postUrl = await searchMovies(title, seasonYear, type as any, targetDomain, s);
                    if (!postUrl) {
                        const altDomain = 'moviesmod.farm';
                        postUrl = await searchMovies(title, seasonYear, type as any, altDomain, s);
                    }
                    if (postUrl) {
                        return processPost(postUrl, type as any, title, Number(s));
                    }
                    return [];
                }));
                allLinks = results.flat();
            }
        } else {
            let postUrl = await searchMovies(title, year, type as any, targetDomain, season?.toString());

            if (!postUrl) {
                // Fallback: If Hollywood fails, try Bollywood domain just in case (or vice versa)
                console.log(`[CineXP Pipeline] Search failed on ${targetDomain}. Trying alternative...`);
                const altDomain = targetDomain === 'moviesmod.farm' ? 'moviesleech.link' : 'moviesmod.farm';
                postUrl = await searchMovies(title, year, type as any, altDomain, season?.toString());
            }
            if (postUrl) {
                allLinks = await processPost(postUrl, type as any, title, season ? Number(season) : undefined);
            }
        }

        if (allLinks.length === 0) {
            return res.status(404).json({ error: "Cloudflare protection or Source not found on target domains." });
        }

        return res.json({
            success: true,
            links: allLinks
        });

    } catch (e: any) {
        return res.status(500).json({ error: e.message || "Internal server error" });
    }
});

// GET /api/media/resolve
app.get('/api/media/resolve', async (req: Request, res: Response) => {
    const url = req.query.url as string;
    const filename = (req.query.filename as string) || 'CineXP-Download.mkv';

    if (!url) {
        return res.status(400).json({ error: "No URL parameter provided" });
    }

    try {
        console.log(`[CineXP Resolver] Starting On-Demand Bypass for: ${url}`);
        
        // 1. Bypass the Modpro Timer
        const driveSeedUrl = await bypassModpro(url);
        if (!driveSeedUrl) {
            return res.status(400).json({ error: "Failed to bypass Modpro. DataCenter IP is likely blocked by their Cloudflare." });
        }

        // 2. Extract final DriveSeed location
        console.log(`[CineXP Resolver] Resolving Driveseed: ${driveSeedUrl}`);
        const finalStreamUrl = await extractDriveSeed(driveSeedUrl);
        if (!finalStreamUrl) {
            return res.status(502).json({ error: "Failed to resolve final stream from DriveSeed." });
        }

        // 3. Return a 302 Redirect directly to the Upstream Google CDN.
        console.log(`[CineXP Resolver] Success! Executing strict off-load to Google CDN.`);
        return res.redirect(302, finalStreamUrl);

    } catch (err: any) {
        console.error(`[CineXP Resolver] Error:`, err);
        return res.status(500).json({ error: err.message || "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`CineXP Scraper Server is running on port ${PORT}`);
});
