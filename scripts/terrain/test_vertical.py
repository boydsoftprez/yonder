# SPDX-License-Identifier: GPL-3.0-or-later
import unittest
from vertical import validate_grids, transform_navd88_to_egm96
class VerticalTests(unittest.TestCase):
 def test_missing_grid_cannot_enable_comparison(self):
  with self.assertRaisesRegex(ValueError,'grid'):validate_grids('/missing')
 def test_unvalidated_vertical_transform_is_never_a_passthrough(self):
  with self.assertRaises(ValueError):transform_navd88_to_egm96([0],[0],[100],'/missing')
if __name__=='__main__':unittest.main()

# Optional integration evidence: runs only with explicitly downloaded, hash-checked grids.
import os
@unittest.skipUnless(os.environ.get('YONDER_TERRAIN_TEST_GRIDS'), 'requires optional source grids')
class RealGridTests(unittest.TestCase):
 def test_conus_geoid12b_to_egm96_at_cove(self):
  output=transform_navd88_to_egm96([-83.3668696],[35.9607874],[315.641734],os.environ['YONDER_TERRAIN_TEST_GRIDS'])
  self.assertAlmostEqual(float(output[0]),316.57462620501155,places=5)
 def test_no_coverage_is_an_error(self):
  with self.assertRaises(Exception):transform_navd88_to_egm96([0],[0],[100],os.environ['YONDER_TERRAIN_TEST_GRIDS'])
