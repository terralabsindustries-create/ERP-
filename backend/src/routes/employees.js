const express = require('express');
const { body, validationResult } = require('express-validator');
const Employee = require('../models/Employee');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');

const router = express.Router();
router.use(protect);

// Build a tenant-scoped filter (dataScope preferred, userId fallback)
function scopeFilter(req, extra = {}) {
  const base = req.user.dataScope
    ? { dataScope: req.user.dataScope }
    : { userId: req.user._id };
  return { ...base, ...extra };
}

// Salary figures are only for logins with Human Resources: View Salary or
// Payroll; everyone else with HR access sees the employee without them.
const canSeeSalary = (user) => userCan(user, 'Human Resources: View Salary') || userCan(user, 'Payroll');
const SALARY_FIELDS = ['salary', 'deductions', 'grossSalary', 'netSalary', 'totalDeductions', 'bankDetails'];
const present = (req, employee) => {
  if (!employee || canSeeSalary(req.user)) return employee;
  const obj = typeof employee.toJSON === 'function' ? employee.toJSON() : { ...employee };
  for (const f of SALARY_FIELDS) delete obj[f];
  return obj;
};

// GET /api/hr/employees - list with optional search/status/department filters
router.get('/', async (req, res) => {
  try {
    const { search, status, department } = req.query;
    const filter = scopeFilter(req);
    if (status && status !== 'all') filter.status = status;
    if (department && department !== 'all') filter.department = department;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { employeeCode: { $regex: search, $options: 'i' } },
        { designation: { $regex: search, $options: 'i' } },
        { department: { $regex: search, $options: 'i' } }
      ];
    }

    const employees = await Employee.find(filter).sort({ createdAt: -1 });

    res.json({ status: 'success', data: { employees: employees.map((e) => present(req, e)) } });
  } catch (error) {
    console.error('List employees error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching employees' });
  }
});

// GET /api/hr/employees/stats - headcount & payroll summary
router.get('/stats/summary', async (req, res) => {
  try {
    const employees = await Employee.find(scopeFilter(req));
    const active = employees.filter(e => e.status === 'active');
    const monthlyPayroll = active.reduce((sum, e) => sum + (e.netSalary || 0), 0);
    const departments = [...new Set(employees.map(e => e.department).filter(Boolean))];

    res.json({
      status: 'success',
      data: {
        total: employees.length,
        active: active.length,
        inactive: employees.length - active.length,
        departments: departments.length,
        monthlyPayroll: canSeeSalary(req.user) ? monthlyPayroll : null
      }
    });
  } catch (error) {
    console.error('Employee stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching employee stats' });
  }
});

// GET /api/hr/employees/:id
router.get('/:id', async (req, res) => {
  try {
    const employee = await Employee.findOne(scopeFilter(req, { _id: req.params.id }));
    if (!employee) return res.status(404).json({ status: 'error', message: 'Employee not found' });
    res.json({ status: 'success', data: { employee: present(req, employee) } });
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching employee' });
  }
});

// POST /api/hr/employees
router.post('/', requirePermission('Human Resources: Create & Edit'), [
  body('name').notEmpty().withMessage('Employee name is required').trim(),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Valid email required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ status: 'error', message: errors.array()[0].msg, errors: errors.array() });
    }

    const data = { ...req.body };
    delete data._id;
    data.createdBy = req.user._id;
    data.userId = req.user._id;
    if (req.user.dataScope) data.dataScope = req.user.dataScope;

    const employee = await Employee.create(data);

    await ActivityLog.logActivity({
      action: 'Employee Created',
      description: `Employee ${employee.name} (${employee.employeeCode}) added`,
      entityType: 'system',
      entityId: employee._id,
      entityName: employee.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(() => {});

    res.status(201).json({ status: 'success', message: 'Employee created successfully', data: { employee } });
  } catch (error) {
    console.error('Create employee error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating employee', error: error.message });
  }
});

// PUT /api/hr/employees/:id
router.put('/:id', requirePermission('Human Resources: Create & Edit'), async (req, res) => {
  try {
    const data = { ...req.body };
    delete data._id;
    delete data.userId;
    delete data.dataScope;
    delete data.createdBy;
    delete data.employeeCode;
    delete data.createdAt;
    delete data.updatedAt;

    const employee = await Employee.findOneAndUpdate(
      scopeFilter(req, { _id: req.params.id }),
      data,
      { new: true, runValidators: true }
    );
    if (!employee) return res.status(404).json({ status: 'error', message: 'Employee not found' });

    res.json({ status: 'success', message: 'Employee updated successfully', data: { employee } });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating employee', error: error.message });
  }
});

// DELETE /api/hr/employees/:id
router.delete('/:id', requirePermission('Human Resources: Delete'), async (req, res) => {
  try {
    const employee = await Employee.findOneAndDelete(scopeFilter(req, { _id: req.params.id }));
    if (!employee) return res.status(404).json({ status: 'error', message: 'Employee not found' });

    // Removing someone from the directory has to take their login with them.
    // The email is unique across accounts, so leaving the login behind means
    // re-adding the same person is refused as a duplicate account.
    let note = '';
    if (employee.linkedUserId) {
      const linked = await User.findById(employee.linkedUserId);
      const sameTenant = linked && (!req.user.dataScope || linked.dataScope === req.user.dataScope);

      if (linked && sameTenant) {
        if (linked._id.equals(req.user._id)) {
          note = ' Your own login was kept.';
        } else if (linked.role === 'admin') {
          // Owner accounts are deliberately not deletable from the HR page.
          note = ' Their admin login was kept — remove it from User Management if you meant to.';
        } else {
          await User.findByIdAndDelete(linked._id);
          note = ' Their login was removed too, so that email can be invited again.';
        }
      }
    }

    await ActivityLog.logActivity({
      action: 'Employee Deleted',
      description: `Employee ${employee.name} (${employee.email || 'no email'}) deleted.${note}`,
      // 'system' matches how the Employee Created entry above is categorised —
      // the enum has no dedicated employee type.
      entityType: 'system',
      entityId: employee._id,
      entityName: employee.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    }).catch(err => console.error('Activity log (delete employee) failed:', err.message));

    res.json({ status: 'success', message: `Employee deleted successfully.${note}` });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting employee' });
  }
});

module.exports = router;
