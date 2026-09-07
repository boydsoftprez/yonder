#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Prepare bounded, attributable one-metre DTM/maximum-return surface tiles.
Optional workstation tool only: Python geospatial wheels never enter runtime packages.
Native NAVD88 heights are preserved. No unverified vertical transform is performed.
"""
import argparse, collections, datetime, gzip, hashlib, json, math, pathlib, sys
import numpy as np

def rasterize_maximum(x, y, z, west, north, columns, rows, out=None):
    if out is None: out = np.full((rows, columns), np.nan, dtype=np.float32)
    col = np.floor(x-west).astype(np.int64); row = np.floor(north-y).astype(np.int64)
    valid = np.isfinite(x)&np.isfinite(y)&np.isfinite(z)&(col>=0)&(row>=0)&(col<columns)&(row<rows)
    # np.fmax ignores a missing previous value while preserving the observed maximum.
    np.fmax.at(out.ravel(), row[valid]*columns+col[valid], z[valid].astype(np.float32))
    return out

def conservative_level(grid, factor):
    if factor == 1: return grid
    rows=math.ceil(grid.shape[0]/factor); columns=math.ceil(grid.shape[1]/factor)
    padded=np.full((rows*factor,columns*factor),np.nan,dtype=np.float32)
    padded[:grid.shape[0],:grid.shape[1]]=grid
    blocks=padded.reshape(rows,factor,columns,factor)
    # Unknown support remains unknown; neither average nor fill removes obstacles.
    return np.max(blocks,axis=(1,3))

def mask_isolated_high_surface(ground, surface):
    """Mark suspect observations unknown; this never substitutes a lower obstacle height.
    Quality heuristic, not an assertion that an isolated structure cannot exist:
    >80m above DTM and >30m above all observed neighbors within a 2m radius.
    Missing neighbors alone cannot establish an outlier. Keep the raw grid unchanged.
    """
    padded=np.pad(surface,2,constant_values=np.nan)
    neighbors=np.full_like(surface,np.nan)
    for dy in range(-2,3):
        for dx in range(-2,3):
            if dx==0 and dy==0:continue
            # A true 2m radius, excluding diagonal cells further than two metres.
            if dx*dx+dy*dy>4:continue
            np.fmax(neighbors,padded[2+dy:2+dy+surface.shape[0],2+dx:2+dx+surface.shape[1]],out=neighbors)
    mask=np.isfinite(ground)&np.isfinite(surface)&np.isfinite(neighbors)&(surface-ground>80)&(surface-neighbors>30)
    screened=surface.copy();screened[mask]=np.nan
    return screened,mask,neighbors

def tile_arrays(grid, cells=128):
    for row in range(0,grid.shape[0]-1,cells):
        for col in range(0,grid.shape[1]-1,cells):
            yield col,row,grid[row:min(row+cells+1,grid.shape[0]),col:min(col+cells+1,grid.shape[1])]

def sha256(path):
    digest=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): digest.update(block)
    return digest.hexdigest()

def prepare(args):
    try:
        import rasterio, laspy, pyproj
        from rasterio.warp import reproject, Resampling
        from rasterio.transform import from_origin
    except ImportError as exc:
        raise SystemExit('Preparation dependencies missing. Install scripts/terrain/requirements.txt in an isolated venv: '+str(exc))
    spec=json.loads(pathlib.Path(args.sources).read_text())
    cache=pathlib.Path(args.cache); output=pathlib.Path(args.output)
    columns,rows=args.columns,args.rows
    if columns<2 or rows<2 or columns>4097 or rows>4097 or columns*rows>8_500_000:raise ValueError('Grid exceeds bounded preparation limit')
    if output.exists() and any(output.iterdir()):raise ValueError('Output directory must be empty; existing packs are immutable')
    sources=[]
    for source in spec['sources']:
        path=cache/source['file']
        if pathlib.Path(source['file']).name!=source['file']:raise ValueError('Unsafe source name')
        if not path.is_file() or path.stat().st_size!=source['bytes'] or sha256(path)!=source['sha256']:raise ValueError('Missing or changed source: '+source['file'])
        sources.append((source,path))
    ground=np.full((rows,columns),np.nan,dtype=np.float32)
    surface=np.full_like(ground,np.nan);lidar_ground=np.full_like(ground,np.nan)
    provenance=[]; statistics={}; dest_crs='EPSG:32617'
    transform=from_origin(args.west,args.north,1,1)
    for source,path in sources:
        provenance_item={key:source[key] for key in ['id','url','sha256','bytes','attribution','surveyStart','surveyEnd']}
        if source['kind']=='dem':
            with rasterio.open(path) as ds:
                if ds.crs.to_epsg()!=26917 or abs(ds.res[0]-1)>1e-8 or abs(ds.res[1]-1)>1e-8:raise ValueError('Unexpected DEM CRS or resolution')
                reproject(source=rasterio.band(ds,1),destination=ground,src_transform=ds.transform,src_crs=ds.crs,src_nodata=ds.nodata,dst_transform=transform,dst_crs=dest_crs,dst_nodata=np.nan,resampling=Resampling.bilinear,num_threads=2,warp_mem_limit=64)
                provenance_item.update(horizontalCrs=ds.crs.to_wkt(),verticalDatum='NAVD88 (catalog metadata; GeoTIFF has horizontal CRS only)',units='metres')
                statistics[source['id']]={'headerCrs':ds.crs.to_string(),'resolutionM':list(ds.res),'nodata':ds.nodata}
        elif source['kind']=='lidar':
            with laspy.open(path) as cloud:
                crs=cloud.header.parse_crs()
                if crs is None or not crs.is_compound:raise ValueError('LiDAR compound CRS is required')
                horizontal,vertical=crs.sub_crs_list
                if horizontal.to_epsg()!=6576 or vertical.to_epsg()!=6360:raise ValueError('Unexpected LiDAR CRS; no guessed units')
                z_scale=vertical.axis_info[0].unit_conversion_factor
                if abs(z_scale-1200/3937)>1e-12:raise ValueError('Expected US survey feet')
                converter=pyproj.Transformer.from_crs(horizontal,dest_crs,always_xy=True,allow_ballpark=False)
                classes=collections.Counter(); kept=0
                for points in cloud.chunk_iterator(500000):
                    classification=np.asarray(points.classification)
                    classes.update(classification.tolist())
                    valid=(classification!=7)&(classification!=18)&(~np.asarray(points.withheld,dtype=bool))
                    if not valid.any():continue
                    x,y=converter.transform(np.asarray(points.x)[valid],np.asarray(points.y)[valid])
                    z=np.asarray(points.z)[valid]*z_scale
                    rasterize_maximum(np.asarray(x),np.asarray(y),z,args.west,args.north,columns,rows,surface)
                    ground_mask=classification[valid]==2
                    rasterize_maximum(np.asarray(x)[ground_mask],np.asarray(y)[ground_mask],z[ground_mask],args.west,args.north,columns,rows,lidar_ground)
                    kept+=int(valid.sum())
                provenance_item.update(horizontalCrs=horizontal.to_wkt(),verticalDatum=vertical.to_wkt(),units='US survey feet (1200/3937 metres)')
                statistics[source['id']]={'points':cloud.header.point_count,'classes':dict(classes),'included':kept,'horizontalOperation':converter.description,'horizontalAccuracyM':converter.accuracy,'verticalScale':z_scale}
        else:raise ValueError('Unknown source kind')
        provenance.append(provenance_item)
    check=np.isfinite(ground)&np.isfinite(lidar_ground)
    residual=(lidar_ground-ground)[check]
    if len(residual)<100:raise ValueError('Insufficient overlapping ground samples')
    median=float(np.median(residual));p95=float(np.percentile(np.abs(residual),95))
    if abs(median)>3 or p95>10:raise ValueError('DTM/LiDAR ground comparison failed: '+str((median,p95)))
    # Below-ground returns cannot lower a mapped surface below the DTM. Both must be observed.
    both=np.isfinite(ground)&np.isfinite(surface)
    surface[both]=np.maximum(surface[both],ground[both])
    raw_surface=surface
    surface,quality_mask,neighbors=mask_isolated_high_surface(ground,raw_surface)
    quality_cells=[{'row':int(row),'column':int(col),'eastingM':args.west+int(col)+.5,'northingM':args.north-int(row)-.5,'rawSurfaceNavd88M':float(raw_surface[row,col]),'groundNavd88M':float(ground[row,col]),'neighborMaximumNavd88M':float(neighbors[row,col])} for row,col in np.argwhere(quality_mask)]
    quality_report={'method':'Isolated high-cell screening; rejected cells become missing surface, never ground or a lower inferred obstacle.','heightAboveGroundThresholdM':80,'heightAboveNeighborThresholdM':30,'neighborRadiusM':2,'comparisons':'Strictly greater than both thresholds; native sample centres within Euclidean radius, at least one observed neighbor required.','maskedCells':len(quality_cells),'rawSurfaceCoverage':float(np.isfinite(raw_surface).mean()),'screenedSurfaceCoverage':float(np.isfinite(surface).mean()),'rawMaximumNavd88M':float(np.nanmax(raw_surface)),'cells':quality_cells}
    vertical_report=None
    if args.grids:
        from vertical import verify,transformer
        horizontal=pyproj.Transformer.from_crs(dest_crs,'EPSG:6318',always_xy=True,allow_ballpark=False)
        controls=[(-83.3668696,35.9607874),(-83.3677125,35.9552468),(-83.3589256,35.9642176),(-83.3624768,35.965772),(-83.365674,35.9540135)]
        vertical_report=verify(args.grids,controls)
        vertical=transformer(args.grids)
        for row in range(0,rows,128):
            end=min(row+128,rows)
            xs,ys=np.meshgrid(args.west+np.arange(columns)+.5,args.north-np.arange(row,end)-.5)
            lon,lat=horizontal.transform(xs,ys)
            shift=np.asarray(vertical.transform(lon.ravel(),lat.ravel(),np.zeros(xs.size),errcheck=True)[2]).reshape(xs.shape)
            if not np.isfinite(shift).all():raise ValueError('Vertical grid missing inside pack')
            ground[row:end]+=shift;surface[row:end]+=shift
    output.mkdir(parents=True,exist_ok=True)
    tiles=[]
    for level in range(args.levels):
        factor=2**level;dtm=conservative_level(ground,factor);dsm=conservative_level(surface,factor)
        for col,row,dtm_tile in tile_arrays(dtm):
            dsm_tile=dsm[row:row+dtm_tile.shape[0],col:col+dtm_tile.shape[1]]
            if not np.isfinite(dtm_tile).any() and not np.isfinite(dsm_tile).any():continue
            tile_id=f'l{level}-{col//128}-{row//128}';filename=tile_id+'.bin.gz'
            raw=dtm_tile.astype('<f4').tobytes()+dsm_tile.astype('<f4').tobytes()
            packed=gzip.compress(raw,compresslevel=9,mtime=0)
            (output/filename).write_bytes(packed)
            tiles.append({'id':tile_id,'file':filename,'sha256':hashlib.sha256(packed).hexdigest(),'bytes':len(packed),'decodedBytes':len(raw),'level':level,'columns':dtm_tile.shape[1],'rows':dtm_tile.shape[0],'spacingM':factor,'originEastingM':args.west+(col+.5)*factor,'originNorthingM':args.north-(row+.5)*factor,'groundCoverage':float(np.isfinite(dtm_tile).mean()),'surfaceCoverage':float(np.isfinite(dsm_tile).mean()),'minGroundM':float(np.nanmin(dtm_tile)) if np.isfinite(dtm_tile).any() else None,'maxSurfaceM':float(np.nanmax(dsm_tile)) if np.isfinite(dsm_tile).any() else None})
    manifest={'schemaVersion':1,'id':args.id,'title':'Cove — USGS 2016 one metre terrain and mapped surface','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'horizontalCrs':{'kind':'UTM','datum':'WGS84','zone':17,'hemisphere':'north'},'verticalDatum':'NAVD88','verticalTransform':{'verified':False,'description':'Native NAVD88 heights retained; LiDAR US survey feet converted exactly to metres. NAVD88 to telemetry height reference has not been validated.','grids':[]},'surfaceDescription':'Highest observed non-noise, non-withheld LiDAR return per one metre cell; building class 6 and unclassified elevated returns. No classified vegetation claim.','sourceResolutionM':1,'sources':provenance,'tiles':tiles,'limitations':['Survey 2016-02-05 through 2016-04-04; trees and construction may have changed.','NAVD88 comparison to generic GPS MSL/EGM96 is unavailable until a verified transform exists.','One metre sample spacing is not one metre absolute accuracy; horizontal transformation reports metre-scale uncertainty.','Missing surface cells remain missing; no water, wire or obstacle completeness claim.','Coarse visual levels retain maximum height only where the complete source block is observed.','Demonstration footprint is bounded; areas beyond it have no package coverage.']}
    if vertical_report:
        manifest['verticalDatum']='EGM96'
        manifest['verticalTransform']={'verified':True,'description':'NAVD88/GEOID12B to EGM96 via hash-checked NOAA CONUS GEOID12B and NGA EGM96 grids; independently interpolated control points and inverse checks passed. This verifies numeric conversion, not physical camera or GNSS registration.','grids':[name+' sha256='+info['sha256']+' '+info['url'] for name,info in vertical_report['grids'].items()]}
        manifest['limitations'][1]='Heights are EGM96 using the 15-minute grid; comparison requires telemetry explicitly identified as EGM96, never generic MSL by assumption.'
    manifest['surfaceDescription']='Quality-screened maximum observed non-noise, non-withheld LiDAR return per one metre cell; building class 6 and unclassified elevated returns. Suspect isolated high cells are missing, not lowered. No classified vegetation claim.'
    manifest['limitations'].append(f"Surface quality heuristic masks {len(quality_cells)} suspect cells: >80 m above DTM and >30 m above every observed neighbor within 2 m. These cells remain unknown; a real isolated obstacle could also meet this criterion. See preparation-report.json for raw values and locations.")
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2,allow_nan=False)+'\n')
    report={'grid':{'west':args.west,'north':args.north,'columns':columns,'rows':rows,'spacingM':1},'groundCoverage':float(np.isfinite(ground).mean()),'surfaceCoverage':float(np.isfinite(surface).mean()),'groundComparison':{'samples':len(residual),'medianM':median,'absoluteP95M':p95},'sources':statistics,'toolVersions':{'python':sys.version.split()[0],'numpy':np.__version__,'rasterio':rasterio.__version__,'gdal':rasterio.__gdal_version__,'pyproj':pyproj.__version__,'proj':pyproj.proj_version_str,'laspy':laspy.__version__},'packedBytes':sum(t['bytes'] for t in tiles),'tiles':len(tiles),'verticalTransform':vertical_report}
    report['surfaceQuality']=quality_report
    (output/'preparation-report.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    print(json.dumps({k:report[k] for k in ['groundCoverage','surfaceCoverage','groundComparison','packedBytes','tiles']},indent=2))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--grids',help='Optional hash-checked NOAA/NGA grid directory; omit to retain unverified NAVD88');p.add_argument('--sources',default='scripts/terrain/cove-sources.json');p.add_argument('--cache',required=True);p.add_argument('--output',required=True);p.add_argument('--id',default='cove-usgs-2016')
    p.add_argument('--west',type=float,default=286080);p.add_argument('--north',type=float,default=3982960)
    p.add_argument('--columns',type=int,default=1537);p.add_argument('--rows',type=int,default=1793);p.add_argument('--levels',type=int,default=5)
    args=p.parse_args()
    if not 1<=args.levels<=8: p.error('levels must be between 1 and 8')
    prepare(args)
if __name__=='__main__':main()
