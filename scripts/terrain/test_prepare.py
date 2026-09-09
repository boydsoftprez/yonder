# SPDX-License-Identifier: GPL-3.0-or-later
import unittest
import numpy as np
from prepare import rasterize_maximum, conservative_level, tile_arrays, mask_isolated_high_surface
class PreparationTests(unittest.TestCase):
    def test_surface_uses_highest_observed_return_and_keeps_holes(self):
        result=rasterize_maximum(np.array([.2,.5,1.1]),np.array([1.8,1.5,.9]),np.array([10.,30.,20.]),0,2,2,2)
        self.assertEqual(result[0,0],30)
        self.assertEqual(result[1,1],20)
        self.assertTrue(np.isnan(result[0,1]))
    def test_coarse_level_preserves_peak_but_never_fills_missing_support(self):
        grid=np.array([[1,2,3,4],[5,99,7,8],[9,10,np.nan,12],[13,14,15,16]],dtype=np.float32)
        out=conservative_level(grid,2)
        self.assertEqual(out[0,0],99)
        self.assertTrue(np.isnan(out[1,1]))
    def test_tiles_share_the_exact_border(self):
        grid=np.arange(25,dtype=np.float32).reshape(5,5)
        tiles=list(tile_arrays(grid,2))
        self.assertEqual(len(tiles),4)
        np.testing.assert_equal(tiles[0][2][:,-1],tiles[1][2][:,0])
    def test_isolated_high_surface_is_unknown_not_filled_with_ground(self):
        ground=np.full((9,9),300,dtype=np.float32);surface=np.full_like(ground,315)
        surface[2,2]=1000;surface[6,6]=450;surface[6,7]=440;surface[0,0]=340
        screened,mask,neighbors=mask_isolated_high_surface(ground,surface)
        self.assertTrue(mask[2,2]);self.assertTrue(np.isnan(screened[2,2]))
        self.assertEqual(surface[2,2],1000)
        self.assertEqual(neighbors[2,2],315)
        self.assertEqual(screened[6,6],450);self.assertEqual(screened[6,7],440)
        self.assertEqual(screened[0,0],340)
        self.assertEqual(int(mask.sum()),1)
    def test_missing_neighbors_do_not_establish_an_outlier(self):
        ground=np.full((5,5),300,dtype=np.float32);surface=np.full_like(ground,np.nan);surface[2,2]=1000
        screened,mask,_=mask_isolated_high_surface(ground,surface)
        self.assertFalse(mask.any());self.assertEqual(screened[2,2],1000)
if __name__=='__main__':unittest.main()
