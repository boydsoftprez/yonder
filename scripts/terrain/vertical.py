# SPDX-License-Identifier: GPL-3.0-or-later
"""Explicit CONUS GEOID12B/NAVD88 to EGM96 transform; no optional/null grid fallback."""
import hashlib, pathlib
import numpy as np
GRIDS={
 'us_noaa_g2012bu0.tif':{'sha256':'954b4959720955ba781a015b8001017ce0c3c0895953991fc731594d58db4af1','bytes':17033175,'url':'https://cdn.proj.org/us_noaa_g2012bu0.tif'},
 'us_nga_egm96_15.tif':{'sha256':'db493027562c9b004d7220fa881f5603adada4e1c5029b933fa7de4547b0e78d','bytes':2710815,'url':'https://cdn.proj.org/us_nga_egm96_15.tif'},
}
PIPELINE='+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=vgridshift +grids=us_noaa_g2012bu0.tif +multiplier=1 +step +inv +proj=vgridshift +grids=us_nga_egm96_15.tif +multiplier=1 +step +proj=unitconvert +xy_in=rad +xy_out=deg'
def validate_grids(directory):
    root=pathlib.Path(directory)
    for name,info in GRIDS.items():
        path=root/name
        if not path.is_file() or path.stat().st_size!=info['bytes']:raise ValueError('Missing or invalid vertical grid '+name)
        if hashlib.sha256(path.read_bytes()).hexdigest()!=info['sha256']:raise ValueError('Vertical grid checksum mismatch '+name)
    return {name:dict(info) for name,info in GRIDS.items()}
def transformer(directory):
    import pyproj
    validate_grids(directory)
    pyproj.network.set_network_enabled(False)
    # Explicit absolute grid paths prevent a same-name grid elsewhere overriding the checked file.
    pipeline=PIPELINE
    for name in GRIDS:pipeline=pipeline.replace('='+name,'='+str((pathlib.Path(directory)/name).resolve()))
    return pyproj.Transformer.from_pipeline(pipeline)
def transform_navd88_to_egm96(longitude,latitude,height,directory):
    result=transformer(directory).transform(longitude,latitude,height,errcheck=True)[2]
    if not np.all(np.isfinite(result)):raise ValueError('Vertical grid does not cover point')
    return result

def bilinear_grid(path,lon,lat):
    """Independent Rasterio pixel interpolation checks PROJ direction and cell convention."""
    import rasterio,math
    with rasterio.open(path) as ds:
        if lon<ds.bounds.left:lon+=360
        x,y=(~ds.transform)*(lon,lat);x-=.5;y-=.5
        col,row=math.floor(x),math.floor(y);dx,dy=x-col,y-row
        if col<0 or row<0 or col+1>=ds.width or row+1>=ds.height:raise ValueError('Vertical grid does not cover control point')
        a=ds.read(1,window=((row,row+2),(col,col+2))).astype(np.float64)
        return float(a[0,0]*(1-dx)*(1-dy)+a[0,1]*dx*(1-dy)+a[1,0]*(1-dx)*dy+a[1,1]*dx*dy)

def verify(directory,points):
    from pyproj.enums import TransformDirection
    tx=transformer(directory);results=[]
    for lon,lat in points:
        n12=bilinear_grid(pathlib.Path(directory)/'us_noaa_g2012bu0.tif',lon,lat)
        n96=bilinear_grid(pathlib.Path(directory)/'us_nga_egm96_15.tif',lon,lat)
        actual=tx.transform(lon,lat,100.,errcheck=True)[2]
        expected=100+n12-n96
        back=tx.transform(lon,lat,actual,direction=TransformDirection.INVERSE,errcheck=True)[2]
        if abs(actual-expected)>1e-5 or abs(back-100)>1e-8:raise ValueError('Vertical transform control-point check failed')
        results.append({'longitude':lon,'latitude':lat,'geoid12bM':n12,'egm96M':n96,'navd88ToEgm96M':actual-100,'independentResidualM':actual-expected,'roundTripResidualM':back-100})
    return {'verified':True,'scope':'Numerical grid conversion; not a camera, GNSS or field-survey calibration','pipeline':PIPELINE,'grids':validate_grids(directory),'controlPoints':results,'limitations':['NAD83(2011) to WGS84 realization uses the documented metre-scale horizontal approximation.','EGM96 15-minute grid interpolation is explicit; another EGM96 grid resolution may differ slightly.']}
